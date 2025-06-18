import { ZenStackClient } from "@zenstackhq/runtime";
import { schema } from "./zenstack/schema";
import { PolicyPlugin } from "@zenstackhq/runtime/plugins/policy";
import { Pool } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import {
  ColumnNode,
  InsertQueryNode,
  UpdateQueryNode,
  ValueNode,
  ValuesNode,
} from "kysely";

// import SQLite from "better-sqlite3";

function extractQueryNodeMutationData(
  queryNode: InsertQueryNode | UpdateQueryNode
): Record<string, unknown> | undefined {
  if (queryNode.kind === "InsertQueryNode") {
    const columns = queryNode.columns?.map((col) => col.column.name) ?? [];
    const values = [
      ...((queryNode.values as ValuesNode)?.values?.[0]?.values ?? []),
    ];

    return Object.fromEntries(
      columns.map((col, i) => [col, values[i] ?? null])
    );
  }

  if (queryNode.kind === "UpdateQueryNode") {
    return Object.fromEntries(
      (queryNode.updates ?? []).map((update) => [
        (update.column as ColumnNode).column.name,
        (update.value as ValueNode).value,
      ])
    );
  }
}

async function main() {
  const db = new ZenStackClient(schema, {
    dialectConfig: {
      // database: new SQLite("./zenstack/dev.db"),
      pool: new Pool(parseIntoClientConfig(process.env.DATABASE_URL!)),
    },
    computedFields: {
      Post: {
        newTitle: (eb) => eb.ref("title"),
        isNotPublished: (eb) => eb.not(eb.ref("published")),
      },
      User: {
        postCount: (eb) =>
          eb
            .selectFrom("Post")
            .whereRef("Post.authorId", "=", "User.id")
            .select(({ fn }) => fn.countAll<number>().as("postCount")),
      },
      Profile: {
        agePlus2: (eb) => eb("Profile.age", "+", 2), // Typing issue resolved when using OperandExpression<number | null>
      },
    },
    procedures: {
      signUp: async (client, email, name) => {
        console.log('Calling "signUp" proc:', email, name);
        return client.user.create({ data: { email, name } });
      },
    },
    // plugins: [new PolicyPlugin()],
    log: ["query", "error"],
  })
    // .$use(new PolicyPlugin())
    .$setAuth({ id: "1", role: "ADMIN" }) // set a dummy auth context
    .$use({
      id: "cost-logger",
      async onQuery({ model, operation, proceed, queryArgs }) {
        const start = Date.now();
        const result = await proceed(queryArgs);
        console.log(
          `[cost] ${model} ${operation} took ${Date.now() - start}ms`
        );
        return result;
      },
    })
    .$use({
      id: "mutation-logger",
      //   mutationInterceptionFilter: (args) => {
      //     return {
      //       //   intercept: ["create", "update"].includes(args.action),
      //       intercept: false,
      //       loadBeforeMutationEntity: false,
      //     };
      //   },
      afterEntityMutation(args) {
        if (
          args.queryNode?.kind === "InsertQueryNode" ||
          args.queryNode?.kind === "UpdateQueryNode"
        ) {
          console.log(
            "[logger] Entity mutation:",
            args.model,
            args.action,
            // args.queryNode?.values?.values,
            // JSON.stringify(args.queryNode, null, 2),
            extractQueryNodeMutationData(
              args.queryNode as InsertQueryNode | UpdateQueryNode
            )
          );
        }
      },
    });
  // clean up existing data
  await db.post.deleteMany();
  await db.profile.deleteMany();
  await db.user.deleteMany();

  // create users and some posts
  const user1 = await db.user.create({
    data: {
      email: "yiming@gmail.com",
      role: "ADMIN",
      posts: {
        create: [
          {
            title: "Post1",
            content: "An unpublished post",
            published: false,
          },
          {
            title: "Post2",
            content: "A published post",
            published: true,
          },
        ],
      },
    },
    include: { posts: true },
  });
  console.log("User created:", user1);

  // create a profile
  const profile = await db.profile.create({
    data: {
      userId: user1.id,
      age: 30,
      bio: "This is a sample profile",
    },
    // include: { user: true },
  });

  console.log("Profile created:", profile);

  const user2 = await db.user.create({
    data: {
      email: "jiasheng@zenstack.dev",
      role: "USER",
      posts: {
        create: {
          title: "Post3",
          content: "Another unpublished post",
          published: false,
        },
      },
    },
    include: { posts: true },
  });
  console.log("User created:", user2);

  const updatedUser2 = await db.user.update({
    where: { id: user2.id },
    data: {
      role: "ADMIN",
    },
  });

  console.log("User 2 updated:", updatedUser2);

  // find with where conditions mixed with low-level Kysely expression builder
  const userWithProperDomain = await db.user.findMany({
    where: {
      role: "USER",
      $expr: (eb) => eb("email", "like", "%@zenstack.dev"),
    },
  });
  console.log("User found with mixed filter:", userWithProperDomain);

  // filter with computed field
  const userWithMorePosts = await db.user.findMany({
    where: {
      role: "ADMIN",
      postCount: {
        gt: 1,
      },
    },
  });
  console.log("User found with computed field:", userWithMorePosts);

  // create with custom procedure
  const newUser = await db.$procedures.signUp("marvin@zenstack.dev", "Marvin");
  console.log("User signed up:", newUser);
}

main();

import { expect, test } from "vitest";
import { createCodeDependencyGraphModule } from "@/lib/code-graph";
import { createCodeIndexModule } from "@/lib/code-index";
import { createMemoryTestContext } from "./support/memory-context";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

test("returns only resolved callees from the selected exact Code Revision", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/code-graph",
    displayName: "Code Graph",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/caller.ts",
        content: [
          "export function caller() {",
          "  return callee();",
          "}",
          "",
          "export function callee() {",
          "  return 'exact-revision';",
          "}",
        ].join("\n"),
      },
    ],
  });

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/code-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "caller",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    repositoryKey: "corespeed/code-graph",
    commitOid: COMMIT_A,
    direction: "callees",
    subject: {
      path: "src/caller.ts",
      symbol: "caller",
      symbolKey: "src/caller.ts#function_declaration:caller",
    },
    truncated: false,
    edges: [
      {
        kind: "calls",
        resolution: "resolved",
        from: {
          path: "src/caller.ts",
          symbol: "caller",
          symbolKey: "src/caller.ts#function_declaration:caller",
        },
        to: {
          path: "src/caller.ts",
          symbol: "callee",
          symbolKey: "src/caller.ts#function_declaration:callee",
        },
        site: { path: "src/caller.ts", startLine: 2, endLine: 2 },
      },
    ],
  });
});

test("keeps same-name call targets ambiguous instead of guessing a definition", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/ambiguous-code-graph",
    displayName: "Ambiguous Code Graph",
    commitOid: COMMIT_A,
    files: [
      { path: "src/a.ts", content: "export function helper() { return 'a'; }\n" },
      { path: "src/b.ts", content: "export function helper() { return 'b'; }\n" },
      {
        path: "src/caller.ts",
        content: [
          'import { helper } from "./a";',
          'import { helper } from "./b";',
          "export function caller() { return helper(); }",
        ].join("\n"),
      },
    ],
  });

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/ambiguous-code-graph",
      commitOid: COMMIT_A,
      direction: "callers",
      symbol: "helper",
    }),
  ).resolves.toMatchObject({
    status: "ambiguous",
    candidates: [
      { path: "src/a.ts", symbolKey: "src/a.ts#function_declaration:helper" },
      { path: "src/b.ts", symbolKey: "src/b.ts#function_declaration:helper" },
    ],
  });

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/ambiguous-code-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "caller",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    edges: [
      {
        kind: "calls",
        targetText: "helper",
        resolution: "ambiguous",
        to: { artifactId: null, path: null, symbol: "helper", symbolKey: null },
      },
    ],
  });

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/ambiguous-code-graph",
      commitOid: COMMIT_A,
      direction: "callers",
      symbol: "src/a.ts#function_declaration:helper",
    }),
  ).resolves.toMatchObject({ status: "ok", edges: [] });
});

test("does not resolve a bare call to an unrelated unique repository symbol", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/unrelated-symbol-graph",
    displayName: "Unrelated Symbol Graph",
    commitOid: COMMIT_A,
    files: [
      { path: "src/unrelated.ts", content: "export function helper() { return 1; }\n" },
      { path: "src/caller.ts", content: "export function caller() { return helper(); }\n" },
    ],
  });

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/unrelated-symbol-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "caller",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    edges: [
      {
        kind: "calls",
        targetText: "helper",
        resolution: "unresolved",
        to: { artifactId: null, symbol: "helper", symbolKey: null },
      },
    ],
  });
});

test("indexes file imports and symbol references without mixing their target semantics", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/dependency-kinds",
    displayName: "Dependency Kinds",
    commitOid: COMMIT_A,
    files: [
      { path: "src/io.ts", content: "export function readData() { return {}; }\n" },
      { path: "src/types.ts", content: "export interface User { id: string }\n" },
      {
        path: "src/consumer.ts",
        content: [
          'import { readData } from "./io";',
          'import type { User } from "./types";',
          "export function loadUser(): User {",
          "  return readData() as User;",
          "}",
        ].join("\n"),
      },
    ],
  });

  const dependencies = await graph.query(context.alice, {
    repositoryKey: "corespeed/dependency-kinds",
    commitOid: COMMIT_A,
    direction: "callees",
    path: "src/consumer.ts",
  });

  expect(dependencies).toMatchObject({
    status: "ok",
    subject: { path: "src/consumer.ts", symbol: null, symbolKey: null },
  });
  if (dependencies.status !== "ok") throw new Error("Expected a resolved path subject");
  const normalizedEdges = dependencies.edges.map((edge) => ({
    kind: edge.kind,
    targetText: edge.targetText,
    resolution: edge.resolution,
    to: {
      path: edge.to.path,
      symbol: edge.to.symbol,
      symbolKey: edge.to.symbolKey,
    },
  }));
  expect(normalizedEdges).toEqual(
    expect.arrayContaining([
      {
        kind: "imports",
        targetText: "./io",
        resolution: "resolved",
        to: { path: "src/io.ts", symbol: null, symbolKey: null },
      },
      {
        kind: "imports",
        targetText: "./types",
        resolution: "resolved",
        to: { path: "src/types.ts", symbol: null, symbolKey: null },
      },
      {
        kind: "calls",
        targetText: "readData",
        resolution: "resolved",
        to: {
          path: "src/io.ts",
          symbol: "readData",
          symbolKey: "src/io.ts#function_declaration:readData",
        },
      },
      {
        kind: "references",
        targetText: "User",
        resolution: "resolved",
        to: {
          path: "src/types.ts",
          symbol: "User",
          symbolKey: "src/types.ts#interface_declaration:User",
        },
      },
    ]),
  );

  const symbolDependencies = await graph.query(context.alice, {
    repositoryKey: "corespeed/dependency-kinds",
    commitOid: COMMIT_A,
    direction: "callees",
    symbol: "loadUser",
  });
  expect(symbolDependencies).toMatchObject({ status: "ok" });
  if (symbolDependencies.status !== "ok") throw new Error("Expected a resolved symbol");
  expect(symbolDependencies.edges.map((edge) => edge.kind)).not.toContain("imports");
});

test("resolves qualified this-calls while preserving unresolved targets", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/method-graph",
    displayName: "Method Graph",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/worker.ts",
        content: [
          "export class Worker {",
          "  run() { this.missing(); return this.work(); }",
          "  work() { return 1; }",
          "}",
        ].join("\n"),
      },
    ],
  });

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/method-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "Worker.run",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    edges: [
      {
        kind: "calls",
        targetText: "this.missing",
        resolution: "unresolved",
        to: { artifactId: null, symbol: "this.missing", symbolKey: null },
      },
      {
        kind: "calls",
        targetText: "this.work",
        resolution: "resolved",
        to: {
          symbol: "Worker.work",
          symbolKey: "src/worker.ts#method_definition:Worker.work",
        },
      },
    ],
  });
});

test("treats declaration chunks as one logical dependency target", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/chunked-target-graph",
    displayName: "Chunked Target Graph",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/chunked.ts",
        content: [
          "export function caller() { return chunkedTarget(); }",
          `export function chunkedTarget() { return ${JSON.stringify("x".repeat(6_500))}; }`,
        ].join("\n"),
      },
    ],
  });

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/chunked-target-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "caller",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    edges: [
      {
        targetText: "chunkedTarget",
        resolution: "resolved",
        to: { symbolKey: "src/chunked.ts#function_declaration:chunkedTarget" },
      },
    ],
  });
});

test("never leaks dependency edges across exact revisions of the same repository", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  for (const [commitOid, target] of [
    [COMMIT_A, "alpha"],
    [COMMIT_B, "beta"],
  ] as const) {
    await code.indexRevision(context.alice, {
      repositoryKey: "corespeed/revision-graph",
      displayName: "Revision Graph",
      commitOid,
      files: [
        {
          path: "src/revision.ts",
          content: [
            `export function caller() { return ${target}(); }`,
            `export function ${target}() { return ${JSON.stringify(commitOid)}; }`,
          ].join("\n"),
        },
      ],
    });
  }

  const revisionA = await graph.query(context.alice, {
    repositoryKey: "corespeed/revision-graph",
    commitOid: COMMIT_A,
    direction: "callees",
    symbol: "caller",
  });
  const revisionB = await graph.query(context.alice, {
    repositoryKey: "corespeed/revision-graph",
    commitOid: COMMIT_B,
    direction: "callees",
    symbol: "caller",
  });
  expect(revisionA).toMatchObject({
    status: "ok",
    edges: [{ targetText: "alpha", to: { symbol: "alpha" } }],
  });
  expect(revisionB).toMatchObject({
    status: "ok",
    edges: [{ targetText: "beta", to: { symbol: "beta" } }],
  });
});

test("applies Workspace RLS and current membership before graph ranking", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/private-workspace-graph",
    displayName: "Private Workspace Graph",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/private.ts",
        content: [
          "export function secretCaller() { return secretTarget(); }",
          "export function secretTarget() { return 'classified'; }",
        ].join("\n"),
      },
    ],
  });

  await expect(
    graph.query(context.bob, {
      repositoryKey: "corespeed/private-workspace-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "secretCaller",
    }),
  ).resolves.toMatchObject({ status: "ok", edges: [{ targetText: "secretTarget" }] });

  await expect(
    graph.query(context.carol, {
      repositoryKey: "corespeed/private-workspace-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "secretCaller",
    }),
  ).resolves.toMatchObject({ status: "not_found", candidates: [] });

  await context.suspendMembership(context.bob);
  await expect(
    graph.query(context.bob, {
      repositoryKey: "corespeed/private-workspace-graph",
      commitOid: COMMIT_A,
      direction: "callees",
      symbol: "secretCaller",
    }),
  ).resolves.toMatchObject({ status: "not_found", candidates: [] });
});

test("hard-bounds high-fanout callers and reports truncation", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);
  const callerCount = 205;

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/high-fanout-graph",
    displayName: "High Fanout Graph",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/fanout.ts",
        content: [
          "export function target() { return 1; }",
          ...Array.from(
            { length: callerCount },
            (_, index) => `export function caller${index}() { return target(); }`,
          ),
        ].join("\n"),
      },
    ],
  });

  const result = await graph.query(context.alice, {
    repositoryKey: "corespeed/high-fanout-graph",
    commitOid: COMMIT_A,
    direction: "callers",
    symbol: "target",
    limit: 200,
  });
  expect(result).toMatchObject({ status: "ok", truncated: true });
  if (result.status !== "ok") throw new Error("Expected a resolved symbol");
  expect(result.edges).toHaveLength(200);

  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/high-fanout-graph",
      commitOid: COMMIT_A,
      direction: "callers",
      symbol: "target",
      limit: 201,
    }),
  ).rejects.toThrow("limit must be an integer from 1 through 200");
});

test("hard-bounds ambiguous symbol candidates and reports truncation", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/ambiguous-fanout-graph",
    displayName: "Ambiguous Fanout Graph",
    commitOid: COMMIT_A,
    files: Array.from({ length: 55 }, (_, index) => ({
      path: `src/duplicate-${index.toString().padStart(2, "0")}.ts`,
      content: `export function duplicate() { return ${index}; }\n`,
    })),
  });

  const result = await graph.query(context.alice, {
    repositoryKey: "corespeed/ambiguous-fanout-graph",
    commitOid: COMMIT_A,
    direction: "callers",
    symbol: "duplicate",
    limit: 50,
  });
  expect(result).toMatchObject({ status: "ambiguous", truncated: true });
  if (result.status !== "ambiguous") throw new Error("Expected an ambiguous symbol");
  expect(result.candidates).toHaveLength(50);
});

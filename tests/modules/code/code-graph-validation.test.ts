import type { PostgresDatabase } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import {
  createCodeDependencyGraphModule,
  type QueryCodeDependenciesInput,
} from "@/modules/code/graph";
import { CodeIndexValidationError } from "@/modules/code/indexing/errors";

// The dependency read now shares the Code Index validators instead of carrying its
// own copies. Malformed input must still be a 400-class validation error raised
// before any transaction, so it can never reach SQL or RLS.

const ACTOR = {
  workspaceId: "20000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000001",
};

const unreachableDatabase: PostgresDatabase = {
  transaction: () => {
    throw new Error("validation must reject the query before opening a transaction");
  },
};

const valid: QueryCodeDependenciesInput = {
  repositoryKey: "corespeed/lore",
  commitOid: "a".repeat(40),
  direction: "callers",
  symbol: "target",
};

function withPath(path: string): QueryCodeDependenciesInput {
  const { symbol: _symbol, ...rest } = valid;
  return { ...rest, path };
}

test("dependency reads reject malformed subjects and revisions before opening a transaction", async () => {
  const graph = createCodeDependencyGraphModule(unreachableDatabase);
  const malformed: ReadonlyArray<readonly [string, QueryCodeDependenciesInput]> = [
    ["a parent-directory path", withPath("../secrets.ts")],
    ["a dot segment", withPath("src/./graph.ts")],
    ["an absolute path", withPath("/etc/passwd")],
    ["a backslash path", withPath("src\\graph.ts")],
    ["an untrimmed path", withPath(" src/graph.ts")],
    ["a control character in a path", withPath("src/gra\u0000ph.ts")],
    ["an empty path", withPath("")],
    ["an abbreviated commit OID", { ...valid, commitOid: "abc1234" }],
    ["a control character in a symbol", { ...valid, symbol: "tar\nget" }],
    ["a blank repository key", { ...valid, repositoryKey: "   " }],
  ];
  for (const [name, input] of malformed) {
    await expect(graph.query(ACTOR, input), name).rejects.toBeInstanceOf(CodeIndexValidationError);
  }
});

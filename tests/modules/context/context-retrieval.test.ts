import { afterEach, expect, test } from "vitest";
import type { AssessedMemoryCitation } from "@/modules/code/evidence";
import { createCodeEvidenceModule } from "@/modules/code/evidence";
import { createCodeIndexReadModule } from "@/modules/code/indexing/read";
import { createCodeIndexModule } from "@/modules/code/indexing/service";
import {
  ContextRetrievalValidationError,
  createContextRetrievalModule,
} from "@/modules/context/retrieval";
import { createApi } from "@/server/api/app";
import type { ActorContext } from "@/server/auth/actor-context";

import { createMemoryModule } from "../../../src/modules/memories/service";
import { createMemoryTestContext } from "../../support/memory-context";

const BASE_COMMIT = "b".repeat(40);
const CURRENT_COMMIT = "c".repeat(40);
const REPOSITORY_KEY = "corespeed/context-retrieval";

/** The pre-batching anchor expansion: one list per Memory and one assess per citation. */
async function sequentialAssessments(
  evidence: ReturnType<typeof createCodeEvidenceModule>,
  actor: ActorContext,
  memoryIds: readonly string[],
  repositoryKey: string,
  commitOid: string,
  limit: number,
): Promise<AssessedMemoryCitation[]> {
  const assessed: AssessedMemoryCitation[] = [];
  for (const memoryId of memoryIds) {
    for (const citation of await evidence.list(actor, { memoryId })) {
      if (assessed.length >= limit) return assessed;
      assessed.push({
        citation,
        assessment: await evidence.assess(actor, {
          evidenceId: citation.id,
          repositoryKey,
          commitOid,
        }),
      });
    }
  }
  return assessed;
}

function policyCheck(allowed: boolean): string {
  const rules = Array.from(
    { length: 350 },
    (_, index) => `  const rule${index.toString().padStart(3, "0")} = true;`,
  );
  return [
    "export function policyCheck() {",
    ...rules,
    `  return ${allowed ? "true" : "false"};`,
    "}",
  ].join("\n");
}

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

test("HTTP retrieves Memory plus exact-revision Code with side-effect-free anchor assessment", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "context-retrieval-alice";
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.alice.userId, process.env.LORE_LOCAL_SUBJECT],
    );
  });
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const codeRead = createCodeIndexReadModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const memory = await memories.remember(context.alice, {
    content: "The tenantGuard rationale was to preserve Workspace isolation.",
  });
  await code.indexRevision(context.alice, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Context Retrieval",
    commitOid: BASE_COMMIT,
    files: [
      {
        path: "src/tenant-guard.ts",
        content: [
          "export function tenantGuard() { return policyCheck(); }",
          policyCheck(true),
        ].join("\n"),
      },
      {
        path: "src/unrelated.ts",
        content: "export function tenantGuard() { return 'unrelated'; }",
      },
    ],
  });
  const [baseArtifact] = await codeRead.search(context.alice, {
    repositoryKey: REPOSITORY_KEY,
    commitOid: BASE_COMMIT,
    query: "tenantGuard",
  });
  if (!baseArtifact) throw new Error("Expected the base tenantGuard Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: baseArtifact.id,
    relationship: "rationale",
  });
  await code.indexRevision(context.alice, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Context Retrieval",
    commitOid: CURRENT_COMMIT,
    files: [
      {
        path: "src/tenant-guard.ts",
        content: [
          "export function tenantGuard() { return policyCheck(); }",
          policyCheck(false),
        ].join("\n"),
      },
      {
        path: "src/unrelated.ts",
        content: "export function tenantGuard() { return 'unrelated'; }",
      },
    ],
  });

  const app = createApi({
    database: () => context.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const response = await app.request(
    new Request("http://lore.local/api/v1/context/retrieve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-workspace-id": context.alice.workspaceId,
      },
      body: JSON.stringify({
        query: "What changed about tenantGuard?",
        memoryQuery: "tenantGuard",
        codeQuery: "no direct current code match",
        repositoryKey: REPOSITORY_KEY,
        commitOid: CURRENT_COMMIT,
        memoryLimit: 5,
        codeLimit: 10,
      }),
    }),
  );
  const packet = (await response.json()) as {
    deliveredRoute: string;
    memories: Array<{ id: string; evidence: string }>;
    code: Array<{ commitOid: string; path: string; symbol: string | null }>;
    anchors: Array<{
      id: string;
      localState: string;
      validatedCommitOid: string | null;
      validatedPath: string | null;
    }>;
    receipt: { requestedCommitOid: string | null };
  };

  expect(response.status).toBe(200);
  expect(packet).toMatchObject({
    deliveredRoute: "both",
    memories: [{ id: memory.id }],
    code: [
      {
        commitOid: CURRENT_COMMIT,
        path: "src/tenant-guard.ts",
        symbol: "tenantGuard",
      },
    ],
    anchors: [
      {
        id: citation.id,
        localState: "current",
        validatedCommitOid: CURRENT_COMMIT,
        validatedPath: "src/tenant-guard.ts",
      },
    ],
    receipt: {
      requestedCommitOid: CURRENT_COMMIT,
      memoryQuery: "tenantGuard",
      codeQuery: "no direct current code match",
      contextualImpact: { state: "affected" },
    },
  });
  const [stored] = await evidence.list(context.alice, { memoryId: memory.id });
  expect(stored).toMatchObject({
    id: citation.id,
    validationState: "current",
    validatedCommitOid: BASE_COMMIT,
  });

  const crossWorkspace = await app.request(
    new Request("http://lore.local/api/v1/context/retrieve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-workspace-id": context.carol.workspaceId,
      },
      body: JSON.stringify({
        query: "tenantGuard",
        repositoryKey: REPOSITORY_KEY,
        commitOid: CURRENT_COMMIT,
        route: "both",
      }),
    }),
  );
  expect(crossWorkspace.status).toBe(403);

  const missingCommit = await app.request(
    new Request("http://lore.local/api/v1/context/retrieve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-workspace-id": context.alice.workspaceId,
      },
      body: JSON.stringify({
        query: "tenantGuard",
        repositoryKey: REPOSITORY_KEY,
        route: "both",
      }),
    }),
  );
  expect(missingCommit.status).toBe(400);
}, 90_000);

test("a co-member's private Memory and its Code anchor never enter the packet", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "context-retrieval-alice";
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.alice.userId, process.env.LORE_LOCAL_SUBJECT],
    );
  });
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const codeRead = createCodeIndexReadModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);

  // Bob shares Alice's Workspace, so only scope keeps this out of her packet.
  const bobPrivate = await memories.remember(context.bob, {
    content: "Bob's private rationale: tenantGuard must stay strict for audit.",
    scope: "private",
  });
  await code.indexRevision(context.bob, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Context Retrieval",
    commitOid: BASE_COMMIT,
    files: [
      {
        path: "src/tenant-guard.ts",
        content: [
          "export function tenantGuard() { return policyCheck(); }",
          policyCheck(true),
        ].join("\n"),
      },
    ],
  });
  const [artifact] = await codeRead.search(context.bob, {
    repositoryKey: REPOSITORY_KEY,
    commitOid: BASE_COMMIT,
    query: "tenantGuard",
  });
  if (!artifact) throw new Error("Expected the tenantGuard Artifact");
  const bobCitation = await evidence.cite(context.bob, {
    memoryId: bobPrivate.id,
    artifactId: artifact.id,
    relationship: "rationale",
  });

  const app = createApi({
    database: () => context.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const response = await app.request(
    new Request("http://lore.local/api/v1/context/retrieve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-workspace-id": context.alice.workspaceId,
      },
      body: JSON.stringify({
        query: "What changed about the tenantGuard rationale?",
        memoryQuery: "tenantGuard rationale audit",
        repositoryKey: REPOSITORY_KEY,
        commitOid: BASE_COMMIT,
        memoryLimit: 10,
        codeLimit: 10,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const packet = (await response.json()) as {
    memories: Array<{ id: string; evidence: string }>;
    anchors: Array<{ id: string; memoryId: string }>;
    receipt: { memoryCandidates: number; anchorCandidates: number };
  };

  expect(packet.memories.map((entry) => entry.id)).not.toContain(bobPrivate.id);
  expect(packet.anchors.map((entry) => entry.id)).not.toContain(bobCitation.id);
  expect(packet.anchors.map((entry) => entry.memoryId)).not.toContain(bobPrivate.id);
  // Not even the content may leak through the evidence excerpt.
  expect(JSON.stringify(packet)).not.toContain("Bob's private rationale");
  expect(packet.receipt.anchorCandidates).toBe(0);
}, 90_000);

test("batched anchor assessment returns exactly what per-citation list and assess return", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const codeRead = createCodeIndexReadModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const retrieval = createContextRetrievalModule(context.database);
  const repositoryKey = "corespeed/batched-anchors";
  const source = (name: string, result: string) =>
    `export function ${name}() { return "${result}"; }\n`;
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Batched anchors",
    commitOid: BASE_COMMIT,
    files: [
      { path: "src/changed.ts", content: source("batchChanged", "before") },
      { path: "src/copied.ts", content: source("batchCopied", "copied") },
      { path: "src/current.ts", content: source("batchCurrent", "current") },
      { path: "src/deleted.ts", content: source("batchDeleted", "deleted") },
      { path: "src/moved.ts", content: source("batchMoved", "moved") },
    ],
  });
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/batched-other",
    displayName: "Batched other repository",
    commitOid: BASE_COMMIT,
    files: [{ path: "src/other.ts", content: source("batchOther", "other") }],
  });
  const artifactFor = async (key: string, query: string) => {
    const [artifact] = await codeRead.search(context.alice, {
      repositoryKey: key,
      commitOid: BASE_COMMIT,
      query,
    });
    if (!artifact) throw new Error(`Expected the ${query} Artifact`);
    return artifact.id;
  };
  const remember = (actor: ActorContext, content: string, scope: "private" | "shared") =>
    memories.remember(actor, { content, scope });
  const first = await remember(context.alice, "Batch anchor rationale for current code.", "shared");
  const second = await remember(
    context.alice,
    "Batch anchor rationale for removed code.",
    "shared",
  );
  const hidden = await remember(
    context.bob,
    "Batch anchor rationale Bob keeps private.",
    "private",
  );
  const third = await remember(context.alice, "Batch anchor rationale for copied code.", "shared");
  const cite = async (actor: ActorContext, memoryId: string, key: string, query: string) =>
    evidence.cite(actor, {
      memoryId,
      artifactId: await artifactFor(key, query),
      relationship: "rationale",
    });
  for (const query of ["batchCurrent", "batchMoved", "batchChanged"]) {
    await cite(context.alice, first.id, repositoryKey, query);
  }
  await cite(context.alice, second.id, repositoryKey, "batchDeleted");
  await cite(context.alice, second.id, "corespeed/batched-other", "batchOther");
  await cite(context.bob, hidden.id, repositoryKey, "batchCurrent");
  await cite(context.alice, third.id, repositoryKey, "batchCopied");
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Batched anchors",
    commitOid: CURRENT_COMMIT,
    files: [
      { path: "src/changed.ts", content: source("batchChanged", "after") },
      { path: "src/copy-a.ts", content: source("batchCopied", "copied") },
      { path: "src/copy-b.ts", content: source("batchCopied", "copied") },
      { path: "src/current.ts", content: source("batchCurrent", "current") },
      { path: "src/relocated.ts", content: source("batchMoved", "moved") },
    ],
  });

  const visible = [first.id, second.id, third.id];
  const expected = await sequentialAssessments(
    evidence,
    context.alice,
    visible,
    repositoryKey,
    CURRENT_COMMIT,
    25,
  );
  expect(expected.map(({ assessment }) => assessment.validationState)).toEqual([
    "current",
    "moved",
    "changed",
    "deleted",
    "unverifiable",
    "ambiguous",
  ]);
  const batch = (memoryIds: readonly string[], limit: number) =>
    evidence.assessMemoryCitations(context.alice, {
      memoryIds,
      repositoryKey,
      commitOid: CURRENT_COMMIT,
      limit,
    });
  // Bob's private Memory is filtered by RLS, and the limit applies in Memory order.
  await expect(batch([first.id, second.id, hidden.id, third.id], 25)).resolves.toEqual(expected);
  await expect(batch(visible, 4)).resolves.toEqual(expected.slice(0, 4));
  await expect(batch([], 25)).resolves.toEqual([]);

  // Retrieval assembles the same anchors for its search results, in search order.
  const memoryQuery = "batch anchor rationale";
  const searched = await memories.search(context.alice, { query: memoryQuery, limit: 10 });
  const packet = await retrieval.retrieve(context.alice, {
    query: "What changed about the batch anchor rationale?",
    memoryQuery,
    repositoryKey,
    commitOid: CURRENT_COMMIT,
    memoryLimit: 10,
  });
  const inSearchOrder = await sequentialAssessments(
    evidence,
    context.alice,
    searched.map((result) => result.memory.id),
    repositoryKey,
    CURRENT_COMMIT,
    25,
  );
  expect(packet.anchors).toEqual(
    inSearchOrder.map(({ citation, assessment }) => ({
      id: citation.id,
      memoryId: citation.memoryId,
      relationship: citation.relationship,
      localState: assessment.validationState,
      citedCommitOid: citation.citedCommitOid,
      citedPath: citation.citedPath,
      validatedCommitOid: assessment.validatedCommitOid,
      validatedPath: assessment.validatedPath,
    })),
  );
  expect(packet.anchors).toHaveLength(6);
  // Assessment never persisted anything.
  for (const memoryId of visible) {
    for (const citation of await evidence.list(context.alice, { memoryId })) {
      expect(citation).toMatchObject({
        validationState: "current",
        validatedCommitOid: BASE_COMMIT,
      });
    }
  }
}, 90_000);

test("context queries keep tabs and line breaks but reject other control characters", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "context-retrieval-alice";
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.alice.userId, process.env.LORE_LOCAL_SUBJECT],
    );
  });
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const retrieval = createContextRetrievalModule(context.database);
  const memory = await memories.remember(context.alice, {
    content: "The tabbed rationale keeps pasted multi-line questions searchable.",
  });
  await code.indexRevision(context.alice, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Context Retrieval",
    commitOid: CURRENT_COMMIT,
    files: [
      {
        path: "src/tabbed.ts",
        content: "export function tabbedRationale() {\n\treturn true;\n}\n",
      },
    ],
  });
  const input = {
    query: "Why does the\ttabbed rationale\nstill hold?",
    memoryQuery: "tabbed\r\nrationale",
    codeQuery: "tabbedRationale() {\n\treturn true;",
    repositoryKey: REPOSITORY_KEY,
    commitOid: CURRENT_COMMIT,
    route: "both" as const,
  };

  const packet = await retrieval.retrieve(context.alice, input);
  expect(packet).toMatchObject({
    query: input.query,
    memories: [{ id: memory.id }],
    code: [{ path: "src/tabbed.ts" }],
    receipt: { memoryQuery: input.memoryQuery, codeQuery: input.codeQuery },
  });
  for (const invalid of [
    { query: "Why does the rationale hold?\0" },
    { memoryQuery: "tabbed\u0007rationale" },
    { codeQuery: "tabbed\u001bRationale" },
  ]) {
    await expect(
      retrieval.retrieve(context.alice, { ...input, ...invalid }),
    ).rejects.toBeInstanceOf(ContextRetrievalValidationError);
  }

  const app = createApi({
    database: () => context.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const post = (body: unknown) =>
    app.request(
      new Request("http://lore.local/api/v1/context/retrieve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lore-workspace-id": context.alice.workspaceId,
        },
        body: JSON.stringify(body),
      }),
    );
  expect((await post(input)).status).toBe(200);
  expect((await post({ ...input, query: "Why\u0000 does it hold?" })).status).toBe(400);
}, 90_000);

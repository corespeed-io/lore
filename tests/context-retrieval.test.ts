import { afterEach, expect, test } from "vitest";
import { createCodeEvidenceModule } from "@/lib/code-evidence";
import { createCodeIndexModule } from "@/lib/code-index";
import { createCodeIndexReadModule } from "@/lib/code-index-read";
import { createContextRetrievalHandlers } from "@/lib/context-http";
import { createMemoryModule } from "@/lib/memory";
import { createMemoryTestContext } from "./support/memory-context";

const BASE_COMMIT = "b".repeat(40);
const CURRENT_COMMIT = "c".repeat(40);
const REPOSITORY_KEY = "corespeed/context-retrieval";

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

  const handler = createContextRetrievalHandlers(context.database);
  const response = await handler.POST(
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

  const crossWorkspace = await handler.POST(
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

  const missingCommit = await handler.POST(
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

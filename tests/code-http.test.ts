import { afterEach, expect, test } from "vitest";
import { createCodeEvidenceModule } from "@/lib/code-evidence";
import {
  createCodeDependencyHandlers,
  createCodeIndexJobHandlers,
  createCodeSearchHandlers,
  createMemoryCodeEvidenceHandlers,
} from "@/lib/code-http";
import { createCodeIndexModule } from "@/lib/code-index";
import { CodeIndexValidationError } from "@/lib/code-index-errors";
import { createCodeIndexQueueModule } from "@/lib/code-index-queue";
import { createMemoryModule } from "@/lib/memory";
import { createMemoryTestContext } from "./support/memory-context";

const COMMIT = "e".repeat(40);

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

test("HTTP exposes bounded Code search and typed Memory evidence without native indexing input", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "code-http-alice";
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.alice.userId, process.env.LORE_LOCAL_SUBJECT],
    );
  });
  const code = createCodeIndexModule(context.database);
  const memories = createMemoryModule(context.database);
  const memory = await memories.remember(context.alice, {
    content: "The HTTP guard is implemented in code.",
  });
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/http-code",
    displayName: "HTTP Code",
    commitOid: COMMIT,
    files: [
      {
        path: "src/http.ts",
        content: [
          "export function httpGuard() { return verifyGuard(); }",
          "export function verifyGuard() { return true; }",
        ].join("\n"),
      },
    ],
  });
  const headers = { "x-lore-workspace-id": context.alice.workspaceId };
  const search = createCodeSearchHandlers(context.database);
  const searchResponse = await search.GET(
    new Request(
      `http://lore.local/api/v1/code/search?repository_key=corespeed%2Fhttp-code&commit_oid=${COMMIT}&q=httpGuard`,
      { headers },
    ),
  );
  const artifacts = (await searchResponse.json()) as Array<{
    declarationChunkOrdinal: number | null;
    id: string;
    matchedChannels: string[];
    path: string;
  }>;
  expect(searchResponse.status).toBe(200);
  expect(artifacts[0]).toMatchObject({
    path: "src/http.ts",
    matchedChannels: expect.arrayContaining(["symbol"]),
  });

  const dependencies = createCodeDependencyHandlers(context.database);
  const dependencyResponse = await dependencies.GET(
    new Request(
      `http://lore.local/api/v1/code/dependencies?repository_key=corespeed%2Fhttp-code&commit_oid=${COMMIT}&direction=callees&symbol=httpGuard&limit=25`,
      { headers },
    ),
  );
  expect(dependencyResponse.status).toBe(200);
  await expect(dependencyResponse.json()).resolves.toMatchObject({
    status: "ok",
    repositoryKey: "corespeed/http-code",
    commitOid: COMMIT,
    direction: "callees",
    subject: { path: "src/http.ts", symbol: "httpGuard" },
    truncated: false,
    edges: [
      {
        kind: "calls",
        resolution: "resolved",
        targetText: "verifyGuard",
        to: { path: "src/http.ts", symbol: "verifyGuard" },
      },
    ],
  });
  const ambiguousSubjectResponse = await dependencies.GET(
    new Request(
      `http://lore.local/api/v1/code/dependencies?repository_key=corespeed%2Fhttp-code&commit_oid=${COMMIT}&direction=callees&symbol=httpGuard&path=src%2Fhttp.ts`,
      { headers },
    ),
  );
  expect(ambiguousSubjectResponse.status).toBe(400);
  await expect(ambiguousSubjectResponse.json()).resolves.toMatchObject({
    code: "invalid_request",
    error: "Provide exactly one of symbol or path",
  });

  const crossWorkspaceResponse = await dependencies.GET(
    new Request(
      `http://lore.local/api/v1/code/dependencies?repository_key=corespeed%2Fhttp-code&commit_oid=${COMMIT}&direction=callees&symbol=httpGuard`,
      { headers: { "x-lore-workspace-id": context.carol.workspaceId } },
    ),
  );
  expect(crossWorkspaceResponse.status).toBe(403);

  const evidence = createMemoryCodeEvidenceHandlers(context.database);
  const citeResponse = await evidence.POST(
    new Request(`http://lore.local/api/v1/memories/${memory.id}/code-evidence`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ artifactId: artifacts[0]?.id, relationship: "implements" }),
    }),
    memory.id,
  );
  const listResponse = await evidence.GET(
    new Request(`http://lore.local/api/v1/memories/${memory.id}/code-evidence`, { headers }),
    memory.id,
  );
  const listed = (await listResponse.json()) as Array<{
    citedCommitOid: string;
    citedDeclarationChunkOrdinal: number | null;
    citedDeclarationContextSha256: string | null;
    relationship: string;
  }>;
  expect(citeResponse.status).toBe(201);
  expect(listResponse.status).toBe(200);
  expect(listed).toMatchObject([
    {
      citedCommitOid: COMMIT,
      citedDeclarationChunkOrdinal: artifacts[0]?.declarationChunkOrdinal,
      citedDeclarationContextSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      relationship: "implements",
    },
  ]);
});

test("HTTP queues only an operator-configured Code Repository without accepting a path", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "code-http-queue-alice";
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.alice.userId, process.env.LORE_LOCAL_SUBJECT],
    );
  });
  const handlers = createCodeIndexJobHandlers(context.database, {
    "corespeed/lore": {
      displayName: "Lore",
      repositoryPath: "/operator/configured/lore",
    },
  });
  const response = await handlers.POST(
    new Request("http://lore.local/api/v1/code/index-jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-workspace-id": context.alice.workspaceId,
      },
      body: JSON.stringify({ repositoryKey: "corespeed/lore", commitOid: COMMIT }),
    }),
  );
  const job = (await response.json()) as Record<string, unknown>;

  expect(response.status).toBe(202);
  expect(job).toMatchObject({
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT,
    status: "pending",
  });
  expect(job).not.toHaveProperty("repositoryPath");

  const unknown = await handlers.POST(
    new Request("http://lore.local/api/v1/code/index-jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-workspace-id": context.alice.workspaceId,
      },
      body: JSON.stringify({ repositoryKey: "unknown/repository", commitOid: COMMIT }),
    }),
  );
  expect(unknown.status).toBe(400);
});

test("an inherited object key is not a configured repository", async () => {
  const module = createCodeIndexQueueModule(
    { transaction: async () => expect.unreachable("no database work for a rejected key") } as never,
    { "corespeed/lore": { displayName: "Lore", repositoryPath: "/srv/lore" } },
  );
  const actor = {} as never;

  for (const repositoryKey of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    await expect(
      module.enqueue(actor, { repositoryKey, commitOid: "a".repeat(40) }),
    ).rejects.toThrow(CodeIndexValidationError);
  }
});

test("the operator job list stays Workspace-scoped, bounded, and free of any repository path", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "code-http-jobs-alice";
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.alice.userId, process.env.LORE_LOCAL_SUBJECT],
    );
  });
  const handlers = createCodeIndexJobHandlers(context.database, {
    "corespeed/lore": { displayName: "Lore", repositoryPath: "/operator/configured/lore" },
    "corespeed/other": { displayName: "Other", repositoryPath: "/operator/configured/other" },
  });
  const headers = { "x-lore-workspace-id": context.alice.workspaceId };
  const queue = createCodeIndexQueueModule(context.database, {
    "corespeed/lore": { displayName: "Lore", repositoryPath: "/operator/configured/lore" },
    "corespeed/other": { displayName: "Other", repositoryPath: "/operator/configured/other" },
  });
  const first = await queue.enqueue(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT,
  });
  const second = await queue.enqueue(context.alice, {
    repositoryKey: "corespeed/other",
    commitOid: "b".repeat(40),
    sourceRef: "refs/heads/main",
  });

  const response = await handlers.GET(
    new Request("http://lore.local/api/v1/code/index-jobs", { headers }),
  );
  const jobs = (await response.json()) as Array<Record<string, unknown>>;
  expect(response.status).toBe(200);
  expect(jobs.map((job) => job.id)).toEqual([second.id, first.id]);
  expect(jobs[0]).toMatchObject({
    repositoryKey: "corespeed/other",
    commitOid: "b".repeat(40),
    sourceRef: "refs/heads/main",
    status: "pending",
    attemptCount: 0,
    lastError: null,
  });
  for (const job of jobs) {
    expect(job).not.toHaveProperty("repositoryPath");
    expect(JSON.stringify(job)).not.toContain("/operator/configured/");
  }

  const bounded = await handlers.GET(
    new Request("http://lore.local/api/v1/code/index-jobs?limit=1", { headers }),
  );
  await expect(bounded.json()).resolves.toHaveLength(1);

  for (const limit of ["0", "101", "2.5", "all"]) {
    const rejected = await handlers.GET(
      new Request(`http://lore.local/api/v1/code/index-jobs?limit=${limit}`, { headers }),
    );
    expect(rejected.status).toBe(400);
  }

  const otherWorkspace = await handlers.GET(
    new Request("http://lore.local/api/v1/code/index-jobs", {
      headers: { "x-lore-workspace-id": context.carol.workspaceId },
    }),
  );
  expect(otherWorkspace.status).toBe(403);
});

test("a co-member never receives the Code citations of a private Memory", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "code-http-evidence-bob";
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.bob.userId, process.env.LORE_LOCAL_SUBJECT],
    );
  });
  const code = createCodeIndexModule(context.database);
  const memories = createMemoryModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/private-evidence";
  const secret = await memories.remember(context.alice, {
    content: "Alice's private note about the retrieval guard.",
    scope: "private",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Private evidence",
    commitOid: COMMIT,
    files: [{ path: "src/secret-guard.ts", content: "export function secretGuard() {}\n" }],
  });
  const [artifact] = await code.search(context.alice, {
    repositoryKey,
    commitOid: COMMIT,
    query: "secretGuard",
  });
  if (!artifact) throw new Error("Expected secretGuard Artifact");
  await evidence.cite(context.alice, {
    memoryId: secret.id,
    artifactId: artifact.id,
    relationship: "supports",
  });

  // Bob is an active member of the same Workspace, so only Memory scope stands
  // between him and the citation.
  const handlers = createMemoryCodeEvidenceHandlers(context.database);
  const response = await handlers.GET(
    new Request(`http://lore.local/api/v1/memories/${secret.id}/code-evidence`, {
      headers: { "x-lore-workspace-id": context.alice.workspaceId },
    }),
    secret.id,
  );
  const body = await response.text();

  expect(response.status).toBe(403);
  expect(body).not.toContain("src/secret-guard.ts");
  expect(body).not.toContain(artifact.id);
  await expect(evidence.list(context.bob, { memoryId: secret.id })).rejects.toThrow(/not visible/);
  await expect(evidence.list(context.alice, { memoryId: secret.id })).resolves.toHaveLength(1);
});

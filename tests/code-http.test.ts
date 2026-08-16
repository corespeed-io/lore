import { afterEach, expect, test } from "vitest";
import {
  createCodeDependencyHandlers,
  createCodeIndexJobHandlers,
  createCodeSearchHandlers,
  createMemoryCodeEvidenceHandlers,
} from "@/lib/code-http";
import { createCodeIndexModule } from "@/lib/code-index";
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

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPostgresDatabase } from "@corespeed/lore-core/postgres";
import { Client } from "pg";
import {
  createActorHandlers,
  createAgentCredentialHandlers,
  createAgentHandlers,
  createCapabilitiesHandlers,
  createEpisodeByIdHandlers,
  createEpisodeHandlers,
  createGraphHandlers,
  createMemoryHandlers,
  createMemoryProposalHandlers,
  createMemoryProposalReviewHandlers,
  createObservationHandlers,
  createReadinessHandlers,
  createWorkspaceHandlers,
} from "../src/lib/http";
import { LORE_SCHEMA_REVISION } from "../src/lib/operations";
import type {
  Episode,
  GraphData,
  HumanActorSummary,
  IssuedAgentCredential,
  Memory,
  MemoryProposal,
  MemoryProposalReviewResult,
  MemorySearchResult,
  WorkspaceAgent,
  WorkspaceSummary,
} from "../src/lib/types";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const smokeDatabaseUrl = process.env.LORE_SMOKE_DATABASE_URL;
if (!smokeDatabaseUrl) {
  throw new Error("LORE_SMOKE_DATABASE_URL is required");
}

function parseSmokeDatabaseUrl(value: string): { databaseName: string; url: URL } {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("LORE_SMOKE_DATABASE_URL must be a Postgres URL");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^(?:[a-z0-9]+[_-])*smoke(?:[_-][a-z0-9]+)*$/i.test(databaseName)) {
    throw new Error(
      "LORE_SMOKE_DATABASE_URL must name a disposable database with smoke as a distinct token",
    );
  }
  return { databaseName, url };
}

async function requireFreshDatabase(connectionString: string, expectedName: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{
      current_database: string;
      has_lore_schema: boolean;
      user_relation_count: string;
      user_schema_count: string;
    }>(`SELECT
         current_database() AS current_database,
         to_regnamespace('lore') IS NOT NULL AS has_lore_schema,
         (
           SELECT count(*)::text
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname <> 'information_schema'
             AND namespace.nspname !~ '^pg_'
         ) AS user_relation_count,
         (
           SELECT count(*)::text
           FROM pg_namespace namespace
           WHERE namespace.nspname NOT IN ('information_schema', 'public')
             AND namespace.nspname !~ '^pg_'
         ) AS user_schema_count`);
    const state = result.rows[0];
    assert.equal(
      state?.current_database === expectedName,
      true,
      "Postgres connected to an unexpected DB",
    );
    if (
      state.has_lore_schema ||
      Number(state.user_relation_count) !== 0 ||
      Number(state.user_schema_count) !== 0
    ) {
      throw new Error("Memory Core smoke requires a fresh, empty disposable database");
    }
  } finally {
    await client.end();
  }
}

async function runNodeScript(
  file: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", [file], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} failed (${signal ?? `exit ${code ?? "unknown"}`})`));
    });
  });
}

function runtimeConnection(adminUrl: URL, role: string, password: string): string {
  const runtimeUrl = new URL(adminUrl);
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  return runtimeUrl.toString();
}

function jsonRequest(
  path: string,
  options: {
    body?: unknown;
    headers?: HeadersInit;
    method?: string;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://lore.local${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function expectStatus(response: Response, status: number, operation: string): Promise<void> {
  if (response.status === status) return;
  let code = "unknown_error";
  try {
    const payload = (await response.clone().json()) as { code?: unknown };
    if (typeof payload.code === "string") code = payload.code;
  } catch {
    // Keep failure output bounded and never reflect Memory or Observation content.
  }
  throw new Error(`${operation}: expected HTTP ${status}, received ${response.status} (${code})`);
}

async function expectJson<T>(response: Response, status: number, operation: string): Promise<T> {
  await expectStatus(response, status, operation);
  return (await response.json()) as T;
}

function selectHumanPrincipal(subject: "smoke-alice" | "smoke-bob"): void {
  process.env.LORE_LOCAL_SUBJECT = subject;
  process.env.LORE_LOCAL_DISPLAY_NAME = subject === "smoke-alice" ? "Smoke Alice" : "Smoke Bob";
}

function workspaceHeaders(workspaceId: string): Record<string, string> {
  return { "x-lore-workspace-id": workspaceId };
}

const { databaseName, url: adminUrl } = parseSmokeDatabaseUrl(smokeDatabaseUrl);
await requireFreshDatabase(smokeDatabaseUrl, databaseName);

const roleSuffix = createHash("sha256").update(databaseName).digest("hex").slice(0, 12);
const runtimeRole = `lore_smoke_request_${roleSuffix}`;
const maintenanceRole = `lore_smoke_maintenance_${roleSuffix}`;
const runtimePassword = randomBytes(32).toString("base64url");
const maintenancePassword = randomBytes(32).toString("base64url");

await runNodeScript("scripts/migrate.mjs", { DATABASE_URL: smokeDatabaseUrl });
await runNodeScript("scripts/create-runtime-role.mjs", {
  DATABASE_URL: smokeDatabaseUrl,
  LORE_RUNTIME_ROLE: runtimeRole,
  LORE_RUNTIME_PASSWORD: runtimePassword,
  LORE_MAINTENANCE_ROLE: maintenanceRole,
  LORE_MAINTENANCE_PASSWORD: maintenancePassword,
});

process.env.AUTH_MODE = "none";
process.env.ALLOW_INSECURE = "1";
selectHumanPrincipal("smoke-alice");

const database = createPostgresDatabase(
  {
    connectionString: runtimeConnection(adminUrl, runtimeRole, runtimePassword),
    max: 4,
  },
  { role: "lore_app" },
);

try {
  const readinessResponse = await createReadinessHandlers(database, {
    embeddingConfigured: true,
    embeddingIdentity: {
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
  }).GET();
  await expectStatus(readinessResponse, 200, "read degraded readiness");
  assert.equal(readinessResponse.headers.get("cache-control"), "no-store");
  const readiness = (await readinessResponse.json()) as {
    components: Record<string, string>;
    status: string;
  };
  assert.deepEqual(readiness, {
    status: "degraded",
    components: {
      database: "ok",
      embedding: "degraded",
      rlsRole: "ok",
      schema: "ok",
      vector: "ok",
    },
  });

  const workspaces = createWorkspaceHandlers(database);
  const actors = createActorHandlers(database);
  const agents = createAgentHandlers(database);
  const credentials = createAgentCredentialHandlers(database);
  const capabilities = createCapabilitiesHandlers(database, { embeddingConfigured: true });
  const episodes = createEpisodeHandlers(database);
  const episodeById = createEpisodeByIdHandlers(database);
  const observations = createObservationHandlers(database);
  const proposals = createMemoryProposalHandlers(database);
  const reviews = createMemoryProposalReviewHandlers(database);
  const memories = createMemoryHandlers(database);
  const graph = createGraphHandlers(database);

  const aliceWorkspace = await expectJson<WorkspaceSummary>(
    await workspaces.POST(
      jsonRequest("/api/v1/workspaces", {
        method: "POST",
        body: { name: "Memory Core Smoke" },
      }),
    ),
    201,
    "create Alice Workspace",
  );
  const aliceHeaders = workspaceHeaders(aliceWorkspace.id);
  const alice = await expectJson<HumanActorSummary>(
    await actors.GET(jsonRequest("/api/v1/actor", { headers: aliceHeaders })),
    200,
    "resolve Alice",
  );

  const deployment = await expectJson<{
    activeEmbeddingGeneration: unknown;
    features: { observationEvidence: boolean };
    schemaRevision: number;
  }>(
    await capabilities.GET(jsonRequest("/api/v1/capabilities", { headers: aliceHeaders })),
    200,
    "read capabilities",
  );
  assert.equal(deployment.schemaRevision, LORE_SCHEMA_REVISION);
  assert.equal(deployment.features.observationEvidence, true);
  assert.equal(
    deployment.activeEmbeddingGeneration === null,
    true,
    "fresh smoke database must not have an active embedding generation",
  );

  const agent = await expectJson<WorkspaceAgent>(
    await agents.POST(
      jsonRequest("/api/v1/agents", {
        method: "POST",
        headers: aliceHeaders,
        body: { name: "Memory smoke agent", permission: "write" },
      }),
    ),
    201,
    "create Agent",
  );
  const credential = await expectJson<IssuedAgentCredential>(
    await credentials.POST(
      jsonRequest(`/api/v1/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: aliceHeaders,
      }),
      agent.id,
    ),
    201,
    "issue Agent credential",
  );
  const agentHeaders = {
    authorization: `Bearer ${credential.token}`,
    "x-lore-workspace-id": aliceWorkspace.id,
  };

  const rawEvidence = "Raw evidence marker: quartz pelican telemetry.";
  const canonicalContent = "The owner uses cobalt lanterns for release notes.";
  const episode = await expectJson<Episode>(
    await episodes.POST(
      jsonRequest("/api/v1/episodes", {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "smoke-episode-canonical-1" },
        body: {
          kind: "conversation",
          scope: "private",
          observations: [
            {
              kind: "message",
              content: rawEvidence,
              metadata: { role: "user" },
              observedAt: "2026-08-10T20:00:00Z",
            },
          ],
        },
      }),
    ),
    201,
    "record Agent Episode",
  );
  assert.equal(episode.recordedByActorKind, "agent");
  assert.equal(episode.recordedByAgentId === agent.id, true, "Agent provenance must be retained");
  const evidenceObservation = episode.observations[0];
  assert.ok(evidenceObservation, "recorded Episode must contain its Observation");
  assert.equal(
    evidenceObservation.content === rawEvidence,
    true,
    "Observation content must round-trip unchanged",
  );

  const rawSearch = await expectJson<MemorySearchResult[]>(
    await memories.GET(
      jsonRequest("/api/v1/memories?q=quartz%20pelican%20telemetry", {
        headers: aliceHeaders,
      }),
    ),
    200,
    "search raw Observation text",
  );
  assert.equal(rawSearch.length, 0, "raw Observations must stay outside canonical retrieval");

  const proposal = await expectJson<MemoryProposal>(
    await proposals.POST(
      jsonRequest("/api/v1/memory-proposals", {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "smoke-proposal-canonical-1" },
        body: {
          kind: "create",
          content: canonicalContent,
          scope: "private",
          metadata: { source: "memory-core-smoke" },
          evidenceObservationIds: [evidenceObservation.id],
        },
      }),
    ),
    201,
    "submit Agent Memory Proposal",
  );
  assert.equal(proposal.status, "pending");
  assert.equal(
    proposal.evidenceObservationIds.length === 1 &&
      proposal.evidenceObservationIds[0] === evidenceObservation.id,
    true,
    "Proposal must retain exactly its submitted Observation evidence",
  );

  await expectStatus(
    await reviews.POST(
      jsonRequest(`/api/v1/memory-proposals/${proposal.id}/review`, {
        method: "POST",
        headers: agentHeaders,
        body: { decision: "accept" },
      }),
      proposal.id,
    ),
    403,
    "reject Agent Proposal review",
  );

  const accepted = await expectJson<MemoryProposalReviewResult>(
    await reviews.POST(
      jsonRequest(`/api/v1/memory-proposals/${proposal.id}/review`, {
        method: "POST",
        headers: aliceHeaders,
        body: { decision: "accept" },
      }),
      proposal.id,
    ),
    200,
    "human accepts Memory Proposal",
  );
  assert.equal(accepted.proposal.status, "accepted");
  assert.equal(
    accepted.memory?.content === canonicalContent,
    true,
    "accepted Proposal must create the proposed canonical content",
  );
  assert.equal(accepted.memory?.scope, "private");
  assert.equal(
    accepted.memory?.id === accepted.proposal.acceptedMemoryId,
    true,
    "accepted Proposal must reference its canonical Memory",
  );

  const acceptedMemory = accepted.memory;
  assert.ok(acceptedMemory, "accepted Proposal must create canonical Memory");
  const canonicalHumanSearch = await expectJson<MemorySearchResult[]>(
    await memories.GET(
      jsonRequest("/api/v1/memories?q=cobalt%20lanterns%20release", {
        headers: aliceHeaders,
      }),
    ),
    200,
    "human lexical search",
  );
  assert.equal(
    canonicalHumanSearch[0]?.memory.id === acceptedMemory.id,
    true,
    "human lexical search must return accepted canonical Memory",
  );
  const canonicalAgentSearch = await expectJson<MemorySearchResult[]>(
    await memories.GET(
      jsonRequest("/api/v1/memories?q=cobalt%20lanterns%20release", {
        headers: agentHeaders,
      }),
    ),
    200,
    "Agent lexical search",
  );
  assert.equal(
    canonicalAgentSearch[0]?.memory.id === acceptedMemory.id,
    true,
    "authorized Agent lexical search must return accepted canonical Memory",
  );
  const rawSearchAfterAcceptance = await expectJson<MemorySearchResult[]>(
    await memories.GET(
      jsonRequest("/api/v1/memories?q=quartz%20pelican%20telemetry", {
        headers: aliceHeaders,
      }),
    ),
    200,
    "search raw Observation text after Proposal acceptance",
  );
  assert.equal(
    rawSearchAfterAcceptance.length,
    0,
    "accepted Proposals must not index their raw Observation evidence",
  );

  const visibleGraph = await expectJson<GraphData>(
    await graph.GET(jsonRequest("/api/v1/graph", { headers: aliceHeaders })),
    200,
    "read Memory Graph",
  );
  assert.equal(
    visibleGraph.nodes.some((node) => node.id === acceptedMemory.id),
    true,
  );
  assert.equal(
    visibleGraph.nodes.some((node) => node.id === evidenceObservation.id),
    false,
    "Observation evidence must not become a Graph node",
  );

  selectHumanPrincipal("smoke-bob");
  const bobWorkspace = await expectJson<WorkspaceSummary>(
    await workspaces.POST(
      jsonRequest("/api/v1/workspaces", {
        method: "POST",
        body: { name: "Bob Smoke Fixture" },
      }),
    ),
    201,
    "create Bob Workspace",
  );
  const bob = await expectJson<HumanActorSummary>(
    await actors.GET(jsonRequest("/api/v1/actor", { headers: workspaceHeaders(bobWorkspace.id) })),
    200,
    "resolve Bob",
  );

  const fixtureClient = new Client({ connectionString: smokeDatabaseUrl });
  await fixtureClient.connect();
  try {
    await fixtureClient.query(
      `INSERT INTO memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [aliceWorkspace.id, bob.userId],
    );
  } finally {
    await fixtureClient.end();
  }

  const bobPrivate = await expectJson<Memory>(
    await memories.POST(
      jsonRequest("/api/v1/memories", {
        method: "POST",
        headers: workspaceHeaders(aliceWorkspace.id),
        body: {
          content: "Bob private marker: indigo narwhal ledger.",
          scope: "private",
        },
      }),
    ),
    201,
    "create Bob private tripwire",
  );
  const bobSearch = await expectJson<MemorySearchResult[]>(
    await memories.GET(
      jsonRequest("/api/v1/memories?q=indigo%20narwhal%20ledger", {
        headers: workspaceHeaders(aliceWorkspace.id),
      }),
    ),
    200,
    "Bob reads own private Memory",
  );
  assert.equal(
    bobSearch[0]?.memory.id === bobPrivate.id,
    true,
    "owner must retrieve their private Memory",
  );

  selectHumanPrincipal("smoke-alice");
  const alicePrivateSearch = await expectJson<MemorySearchResult[]>(
    await memories.GET(
      jsonRequest("/api/v1/memories?q=indigo%20narwhal%20ledger", {
        headers: aliceHeaders,
      }),
    ),
    200,
    "Alice cannot read Bob private Memory",
  );
  assert.equal(alicePrivateSearch.length, 0, "co-member must not retrieve private Memory");
  const agentPrivateSearch = await expectJson<MemorySearchResult[]>(
    await memories.GET(
      jsonRequest("/api/v1/memories?q=indigo%20narwhal%20ledger", {
        headers: agentHeaders,
      }),
    ),
    200,
    "Alice Agent cannot read Bob private Memory",
  );
  assert.equal(agentPrivateSearch.length, 0, "co-member Agent must not retrieve private Memory");
  const aliceIsolatedGraph = await expectJson<GraphData>(
    await graph.GET(jsonRequest("/api/v1/graph", { headers: aliceHeaders })),
    200,
    "exclude Bob private Memory from Alice Graph",
  );
  assert.equal(
    aliceIsolatedGraph.nodes.some((node) => node.id === bobPrivate.id),
    false,
  );

  await expectStatus(
    await memories.GET(
      jsonRequest("/api/v1/memories", { headers: workspaceHeaders(bobWorkspace.id) }),
    ),
    403,
    "reject Alice cross-Workspace read",
  );
  await expectStatus(
    await memories.GET(
      jsonRequest("/api/v1/memories", {
        headers: { ...agentHeaders, "x-lore-workspace-id": bobWorkspace.id },
      }),
    ),
    403,
    "reject Agent cross-Workspace read",
  );

  const disposableEpisode = await expectJson<Episode>(
    await episodes.POST(
      jsonRequest("/api/v1/episodes", {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "smoke-episode-forget-1" },
        body: {
          kind: "event",
          observations: [{ kind: "event", content: "Disposable evidence marker: silver kestrel." }],
        },
      }),
    ),
    201,
    "record disposable Episode",
  );
  const disposableObservationId = disposableEpisode.observations[0]?.id;
  assert.ok(disposableObservationId);
  const doomedProposal = await expectJson<MemoryProposal>(
    await proposals.POST(
      jsonRequest("/api/v1/memory-proposals", {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "smoke-proposal-forget-1" },
        body: {
          kind: "create",
          content: "This Proposal must not survive forgotten evidence.",
          evidenceObservationIds: [disposableObservationId],
        },
      }),
    ),
    201,
    "submit disposable-evidence Proposal",
  );
  await expectStatus(
    await episodeById.DELETE(
      jsonRequest(`/api/v1/episodes/${disposableEpisode.id}`, {
        method: "DELETE",
        headers: { ...aliceHeaders, "idempotency-key": "smoke-forget-episode-1" },
      }),
      disposableEpisode.id,
    ),
    204,
    "forget Episode",
  );
  const forgottenEvidence = await expectJson<unknown[]>(
    await observations.GET(
      jsonRequest(`/api/v1/observations?id=${disposableObservationId}`, {
        headers: aliceHeaders,
      }),
    ),
    200,
    "read forgotten Observation",
  );
  assert.equal(forgottenEvidence.length, 0, "forgotten Observation must be unavailable");
  const conflictedReview = await reviews.POST(
    jsonRequest(`/api/v1/memory-proposals/${doomedProposal.id}/review`, {
      method: "POST",
      headers: aliceHeaders,
      body: { decision: "accept" },
    }),
    doomedProposal.id,
  );
  await expectStatus(conflictedReview, 409, "refuse Proposal with forgotten evidence");
  const conflictBody = (await conflictedReview.json()) as { code?: string };
  assert.equal(conflictBody.code, "proposal_review_conflict");

  assert.equal(alice.userId !== bob.userId, true, "smoke Actors must resolve to distinct Users");
  console.log("Memory Core smoke passed: schema, RLS, governance, retrieval, and degraded mode");
} finally {
  await database.close();
  for (const key of [
    "AUTH_MODE",
    "ALLOW_INSECURE",
    "LORE_LOCAL_SUBJECT",
    "LORE_LOCAL_DISPLAY_NAME",
  ]) {
    delete process.env[key];
  }
}

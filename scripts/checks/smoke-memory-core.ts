import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createEmbeddingMaintenance, type EmbeddingProvider } from "@corespeed/lore-core";
import type {
  Episode,
  HumanActor,
  IssuedAgentCredential,
  MemoryProposal,
  MemoryProposalReviewResult,
  MemorySearchResult,
  WorkspaceAgent,
  WorkspaceSummary,
} from "@corespeed/lore-sdk";
import { Client } from "pg";
import type { GraphData } from "../../src/modules/graph/browser/types";
import type { Memory } from "../../src/modules/memories/schemas";
import { LORE_SCHEMA_REVISION } from "../../src/modules/operations/service";
import { createApi } from "../../src/server/api/app";
import {
  createPostgresDatabase,
  createRequestPostgresDatabase,
} from "../../src/server/database/postgres";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
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

async function runBunScript(
  file: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", file],
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LORE_DBMATE_BINARY: process.env.LORE_DBMATE_BINARY,
      ...environment,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${file} failed (${child.signalCode ?? `exit ${code}`})`);
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

/**
 * Wait until `count` sessions queue behind a lock this client's own session holds,
 * so an unrelated waiter on a shared server cannot satisfy it. A second waiter on a
 * row queues behind the first one's tuple lock, not the holder's, so the count
 * follows the whole wait chain. `pg_locks` is read live and needs no statistics
 * privileges, unlike `pg_stat_activity`, whose snapshot an open transaction would
 * also freeze.
 */
async function waitForLockWaiters(client: Client, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await client.query<{ waiting: number }>(
      `WITH RECURSIVE queued(pid) AS (
         SELECT pg_backend_pid()
         UNION
         SELECT waiting.pid
         FROM pg_locks waiting
         JOIN queued ON queued.pid = ANY (pg_blocking_pids(waiting.pid))
         WHERE NOT waiting.granted
       )
       SELECT (count(*) - 1)::integer AS waiting FROM queued`,
    );
    if ((result.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Expected ${count} sessions waiting on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

await runBunScript("scripts/database/migrate.ts", { DATABASE_URL: smokeDatabaseUrl });
await runBunScript("scripts/database/create-runtime-role.ts", {
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
  const app = createApi({
    database: () => database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const readinessResponse = await createApi({
    database: () => database,
    memoryOptions: () => ({
      embeddingProvider: {
        provider: "ollama",
        model: "qwen3-embedding:0.6b",
        dimensions: 1024,
        revision: "lore-embedding-v2",
        async embed() {
          throw new Error("Readiness must not call the embedding provider");
        },
      },
    }),
    codeRepositories: () => ({}),
  }).request("/readyz");
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

  const aliceWorkspace = await expectJson<WorkspaceSummary>(
    await app.request(
      jsonRequest("/api/v1/workspaces", {
        method: "POST",
        body: { name: "Memory Core Smoke" },
      }),
    ),
    201,
    "create Alice Workspace",
  );
  const aliceHeaders = workspaceHeaders(aliceWorkspace.id);
  const alice = await expectJson<HumanActor>(
    await app.request(jsonRequest("/api/v1/actor", { headers: aliceHeaders })),
    200,
    "resolve Alice",
  );

  const deployment = await expectJson<{
    activeEmbeddingGeneration: unknown;
    features: { observationEvidence: boolean };
    schemaRevision: number;
  }>(
    await app.request(jsonRequest("/api/v1/capabilities", { headers: aliceHeaders })),
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
    await app.request(
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
    await app.request(
      jsonRequest(`/api/v1/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: aliceHeaders,
      }),
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
    await app.request(
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
    await app.request(
      jsonRequest("/api/v1/memories?q=quartz%20pelican%20telemetry", {
        headers: aliceHeaders,
      }),
    ),
    200,
    "search raw Observation text",
  );
  assert.equal(rawSearch.length, 0, "raw Observations must stay outside canonical retrieval");

  const proposal = await expectJson<MemoryProposal>(
    await app.request(
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
    await app.request(
      jsonRequest(`/api/v1/memory-proposals/${proposal.id}/review`, {
        method: "POST",
        headers: agentHeaders,
        body: { decision: "accept" },
      }),
    ),
    403,
    "reject Agent Proposal review",
  );

  const accepted = await expectJson<MemoryProposalReviewResult>(
    await app.request(
      jsonRequest(`/api/v1/memory-proposals/${proposal.id}/review`, {
        method: "POST",
        headers: aliceHeaders,
        body: { decision: "accept" },
      }),
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
    await app.request(
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
    await app.request(
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
    await app.request(
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
    await app.request(jsonRequest("/api/v1/graph", { headers: aliceHeaders })),
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
    await app.request(
      jsonRequest("/api/v1/workspaces", {
        method: "POST",
        body: { name: "Bob Smoke Fixture" },
      }),
    ),
    201,
    "create Bob Workspace",
  );
  const bob = await expectJson<HumanActor>(
    await app.request(jsonRequest("/api/v1/actor", { headers: workspaceHeaders(bobWorkspace.id) })),
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
    await app.request(
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
    await app.request(
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
    await app.request(
      jsonRequest("/api/v1/memories?q=indigo%20narwhal%20ledger", {
        headers: aliceHeaders,
      }),
    ),
    200,
    "Alice cannot read Bob private Memory",
  );
  assert.equal(alicePrivateSearch.length, 0, "co-member must not retrieve private Memory");
  const agentPrivateSearch = await expectJson<MemorySearchResult[]>(
    await app.request(
      jsonRequest("/api/v1/memories?q=indigo%20narwhal%20ledger", {
        headers: agentHeaders,
      }),
    ),
    200,
    "Alice Agent cannot read Bob private Memory",
  );
  assert.equal(agentPrivateSearch.length, 0, "co-member Agent must not retrieve private Memory");
  const aliceIsolatedGraph = await expectJson<GraphData>(
    await app.request(jsonRequest("/api/v1/graph", { headers: aliceHeaders })),
    200,
    "exclude Bob private Memory from Alice Graph",
  );
  assert.equal(
    aliceIsolatedGraph.nodes.some((node) => node.id === bobPrivate.id),
    false,
  );

  // Memory Links are written by natural key under the same RLS roles.
  const linkTarget = await expectJson<Memory>(
    await app.request(
      jsonRequest("/api/v1/memories", {
        method: "POST",
        headers: aliceHeaders,
        body: { content: "Release notes cite the lantern review." },
      }),
    ),
    201,
    "create Link target",
  );
  const racePath = `/api/v1/memories/${acceptedMemory.id}/links/${linkTarget.id}?kind=race`;
  // Hold the source row so both PUTs queue behind it and reach their Link writes
  // together: one must create the Link and the other replace that same Link, never
  // fail on the natural key.
  const blocker = new Client({ connectionString: smokeDatabaseUrl });
  await blocker.connect();
  let raced: Response[];
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM memories WHERE id = $1 FOR UPDATE", [acceptedMemory.id]);
    const pending: Array<Response | Promise<Response>> = [];
    for (const waiting of [1, 2]) {
      pending.push(
        app.request(jsonRequest(racePath, { method: "PUT", headers: aliceHeaders, body: {} })),
      );
      await waitForLockWaiters(blocker, waiting);
    }
    await blocker.query("COMMIT");
    raced = await Promise.all(pending);
  } finally {
    await blocker.end();
  }
  assert.deepEqual(
    raced.map((response) => response.status).sort(),
    [200, 201],
    "concurrent PUTs of one new Link must create it once and replace it once",
  );
  const racedIds = await Promise.all(
    raced.map(async (response) => ((await response.json()) as { id: string }).id),
  );
  assert.equal(racedIds[0], racedIds[1], "one natural key must be one Link");
  await expectStatus(
    await app.request(jsonRequest(racePath, { method: "DELETE", headers: aliceHeaders })),
    204,
    "delete the raced Memory Link",
  );
  // A forget under way when a Proposal is submitted must not leave that Proposal, or
  // its replay body, behind. An update's target is locked, so the submission waits
  // and then finds no target; an evidence Memory's foreign key waits the same way and
  // then refuses the row. Both answer 403, and nothing is stored.
  const forgetRaces: Array<{ key: string; body: (memoryId: string) => Record<string, unknown> }> = [
    {
      key: "smoke-proposal-forget-race-target",
      body: (memoryId) => ({
        kind: "update",
        targetMemoryId: memoryId,
        expectedVersion: 1,
        content: "Forget race proposal: amber heron.",
      }),
    },
    {
      key: "smoke-proposal-forget-race-evidence",
      body: (memoryId) => ({
        kind: "create",
        content: "Forget race proposal citing forgotten evidence: amber heron.",
        evidenceMemoryIds: [memoryId],
      }),
    },
  ];
  for (const race of forgetRaces) {
    const forgotten = await expectJson<{ id: string }>(
      await app.request(
        jsonRequest("/api/v1/memories", {
          method: "POST",
          headers: aliceHeaders,
          body: { content: `Forget race Memory for ${race.key}.` },
        }),
      ),
      201,
      `create Memory for ${race.key}`,
    );
    const forgetter = new Client({ connectionString: smokeDatabaseUrl });
    await forgetter.connect();
    try {
      await forgetter.query("BEGIN");
      await forgetter.query("DELETE FROM memories WHERE id = $1", [forgotten.id]);
      const submitting = app.request(
        jsonRequest("/api/v1/memory-proposals", {
          method: "POST",
          headers: { ...aliceHeaders, "idempotency-key": race.key },
          body: race.body(forgotten.id),
        }),
      );
      await waitForLockWaiters(forgetter, 1);
      await forgetter.query("COMMIT");
      await expectStatus(
        await submitting,
        403,
        `refuse ${race.key} after its Memory was forgotten`,
      );
      const leftovers = await forgetter.query<{ proposals: number; replays: number }>(
        `SELECT
           (SELECT count(*)::integer FROM memory_proposals
            WHERE target_memory_id = $1 OR proposed_content LIKE 'Forget race proposal%') AS proposals,
           (SELECT count(*)::integer FROM request_idempotency_records
            WHERE idempotency_key = $2) AS replays`,
        [forgotten.id, race.key],
      );
      assert.deepEqual(
        leftovers.rows[0],
        { proposals: 0, replays: 0 },
        `${race.key}: a forget racing a Proposal submission must leave neither behind`,
      );
    } finally {
      await forgetter.end();
    }
  }
  const linkPath = `/api/v1/memories/${acceptedMemory.id}/links/${linkTarget.id}?kind=cites`;
  const createdLink = await expectJson<{ id: string; weight: number }>(
    await app.request(
      jsonRequest(linkPath, { method: "PUT", headers: aliceHeaders, body: { weight: 0.3 } }),
    ),
    201,
    "create Memory Link",
  );
  assert.equal(createdLink.weight, 0.3, "a real Link weight must round-trip exactly");
  const repeatedLink = await expectJson<{ id: string }>(
    await app.request(
      jsonRequest(linkPath, { method: "PUT", headers: aliceHeaders, body: { weight: 0.3 } }),
    ),
    200,
    "repeat Memory Link",
  );
  assert.deepEqual(repeatedLink, createdLink, "a repeated Link PUT must change nothing");
  const inboundLinks = await expectJson<Array<{ id: string }>>(
    await app.request(
      jsonRequest(`/api/v1/memories/${linkTarget.id}/links?direction=inbound`, {
        headers: aliceHeaders,
      }),
    ),
    200,
    "list the target's inbound Memory Links",
  );
  assert.deepEqual(
    inboundLinks.map((link) => link.id),
    [createdLink.id],
    "the target must list exactly the Link just written",
  );
  await expectStatus(
    await app.request(
      jsonRequest(`/api/v1/memories/${bobPrivate.id}/links`, { headers: aliceHeaders }),
    ),
    404,
    "refuse to list Bob private Memory's Links",
  );
  await expectStatus(
    await app.request(
      jsonRequest(`/api/v1/memories/${acceptedMemory.id}/links/${bobPrivate.id}`, {
        method: "PUT",
        headers: aliceHeaders,
        body: {},
      }),
    ),
    404,
    "refuse a Link to Bob private Memory",
  );
  await expectStatus(
    await app.request(jsonRequest(linkPath, { method: "DELETE", headers: agentHeaders })),
    204,
    "delete Memory Link through Alice's write-granted Agent",
  );
  await expectStatus(
    await app.request(jsonRequest(linkPath, { method: "DELETE", headers: aliceHeaders })),
    404,
    "repeat Memory Link deletion",
  );

  await expectStatus(
    await app.request(
      jsonRequest("/api/v1/memories", { headers: workspaceHeaders(bobWorkspace.id) }),
    ),
    403,
    "reject Alice cross-Workspace read",
  );
  await expectStatus(
    await app.request(
      jsonRequest("/api/v1/memories", {
        headers: { ...agentHeaders, "x-lore-workspace-id": bobWorkspace.id },
      }),
    ),
    403,
    "reject Agent cross-Workspace read",
  );

  const disposableEpisode = await expectJson<Episode>(
    await app.request(
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
    await app.request(
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
    await app.request(
      jsonRequest(`/api/v1/episodes/${disposableEpisode.id}`, {
        method: "DELETE",
        headers: { ...aliceHeaders, "idempotency-key": "smoke-forget-episode-1" },
      }),
    ),
    204,
    "forget Episode",
  );
  const forgottenEvidence = await expectJson<unknown[]>(
    await app.request(
      jsonRequest(`/api/v1/observations?id=${disposableObservationId}`, {
        headers: aliceHeaders,
      }),
    ),
    200,
    "read forgotten Observation",
  );
  assert.equal(forgottenEvidence.length, 0, "forgotten Observation must be unavailable");
  const conflictedReview = await app.request(
    jsonRequest(`/api/v1/memory-proposals/${doomedProposal.id}/review`, {
      method: "POST",
      headers: aliceHeaders,
      body: { decision: "accept" },
    }),
  );
  await expectStatus(conflictedReview, 409, "refuse Proposal with forgotten evidence");
  const conflictBody = (await conflictedReview.json()) as { code?: string };
  assert.equal(conflictBody.code, "proposal_review_conflict");

  // An update replaces only the chunks it changed, so the rest keep their ids and
  // vectors, and an embedding completion for a version an update replaced while the
  // provider call was in flight writes nothing. The provider identity is the one
  // the CI maintenance cycle serves, so that cycle still finds this generation.
  const embeddedTexts: string[][] = [];
  let providerGate: Promise<void> | undefined;
  const smokeEmbeddings: EmbeddingProvider = {
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    revision: "lore-embedding-v2",
    async embed(texts) {
      embeddedTexts.push(texts);
      await providerGate;
      return texts.map((_text, index) =>
        Array.from({ length: 1024 }, (_value, slot) => (slot === index ? 1 : 0)),
      );
    },
  };
  const embeddingApp = createApi({
    database: () => database,
    memoryOptions: () => ({ embeddingProvider: smokeEmbeddings }),
    codeRepositories: () => ({}),
  });
  const maintenanceDatabase = createPostgresDatabase(
    {
      connectionString: runtimeConnection(adminUrl, maintenanceRole, maintenancePassword),
      max: 2,
    },
    { role: "lore_maintenance" },
  );
  const inspector = new Client({ connectionString: smokeDatabaseUrl });
  await inspector.connect();
  try {
    const maintenance = createEmbeddingMaintenance(maintenanceDatabase, {
      embeddingProviders: [smokeEmbeddings],
    });
    const paragraph = (text: string) => `${text} `.repeat(Math.ceil(900 / (text.length + 1)));
    const body = (...texts: string[]) => texts.map(paragraph).join("\n\n");
    const chunked = await expectJson<Memory>(
      await embeddingApp.request(
        jsonRequest("/api/v1/memories", {
          method: "POST",
          headers: aliceHeaders,
          body: { content: body("Pier one log.", "Pier two log.", "Pier three log.") },
        }),
      ),
      201,
      "create the chunk-reuse Memory",
    );
    const patch = async (version: number, input: Record<string, unknown>) =>
      expectJson<Memory>(
        await embeddingApp.request(
          jsonRequest(`/api/v1/memories/${chunked.id}`, {
            method: "PATCH",
            headers: { ...aliceHeaders, "if-match": `"memory-v${version}"` },
            body: input,
          }),
        ),
        200,
        `update the chunk-reuse Memory from version ${version}`,
      );
    const jobFor = async (version: number) => {
      const job = await inspector.query<{ id: string }>(
        "SELECT id FROM memory_embedding_jobs WHERE memory_id = $1 AND memory_version = $2",
        [chunked.id, version],
      );
      const id = job.rows[0]?.id;
      assert.ok(id, `version ${version} must have queued an embedding job`);
      return id;
    };
    const chunkState = async () =>
      (
        await inspector.query<{ id: string; ordinal: number; embedded: boolean }>(
          `SELECT chunk.id, chunk.ordinal,
                  EXISTS (SELECT 1 FROM memory_chunk_embeddings vector
                          WHERE vector.chunk_id = chunk.id) AS embedded
           FROM memory_chunks chunk WHERE chunk.memory_id = $1 ORDER BY chunk.ordinal`,
          [chunked.id],
        )
      ).rows;

    assert.equal((await maintenance.run({ jobId: await jobFor(1) })).status, "complete");
    const original = await chunkState();
    assert.deepEqual(
      original.map((chunk) => chunk.embedded),
      [true, true, true],
    );

    // Version 2 replaces only the middle chunk; its job claims that chunk alone and
    // waits in the provider while version 3 replaces the last chunk.
    await patch(1, { content: body("Pier one log.", "Pier two tide.", "Pier three log.") });
    let releaseProvider: () => void = () => undefined;
    providerGate = new Promise((resolve) => {
      releaseProvider = resolve;
    });
    const staleRun = maintenance.run({ jobId: await jobFor(2) });
    const providerDeadline = Date.now() + 10_000;
    while (embeddedTexts.length < 2) {
      if (Date.now() > providerDeadline)
        throw new Error("The version 2 job never called the provider");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await patch(2, { content: body("Pier one log.", "Pier two tide.", "Pier three crane.") });
    releaseProvider();
    providerGate = undefined;
    assert.notEqual(
      (await staleRun).status,
      "complete",
      "a completion for a replaced version must be fenced",
    );
    const replaced = await chunkState();
    assert.equal(replaced[0]?.id, original[0]?.id, "an unchanged chunk keeps its id");
    assert.deepEqual(
      replaced.map((chunk) => chunk.embedded),
      [true, false, false],
      "an unchanged chunk keeps its vector and a fenced completion writes none",
    );

    assert.equal((await maintenance.run({ jobId: await jobFor(3) })).status, "complete");
    assert.deepEqual(
      embeddedTexts.map((texts) => texts.length),
      [3, 1, 2],
      "each job embeds only the chunks that lack a vector",
    );
    assert.deepEqual(
      (await chunkState()).map((chunk) => chunk.embedded),
      [true, true, true],
    );

    // A scope change with every chunk embedded rewrites no chunk and queues no job.
    const jobsBefore = await inspector.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM memory_embedding_jobs WHERE memory_id = $1",
      [chunked.id],
    );
    const scoped = await patch(3, { scope: "private" });
    assert.equal(scoped.version, 4);
    assert.deepEqual(
      (await chunkState()).map((chunk) => chunk.id),
      replaced.map((chunk) => chunk.id),
    );
    const jobsAfter = await inspector.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM memory_embedding_jobs WHERE memory_id = $1",
      [chunked.id],
    );
    assert.equal(jobsAfter.rows[0]?.count, jobsBefore.rows[0]?.count);

    // Equal fields write nothing: same version and ETag, no event.
    const eventsBefore = await inspector.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM memory_events WHERE resource_id = $1",
      [chunked.id],
    );
    const unchanged = await patch(4, { scope: "private", content: scoped.content });
    assert.deepEqual(unchanged, scoped);
    const eventsAfter = await inspector.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM memory_events WHERE resource_id = $1",
      [chunked.id],
    );
    assert.equal(eventsAfter.rows[0]?.count, eventsBefore.rows[0]?.count);

    // A provider-backed search on PostgreSQL, through the dense channel alone. No
    // lexical or CJK channel can match this query, and the fixture embeds every
    // single text as the first basis vector, which the first chunk of each embedded
    // batch also holds, so only a dense candidate can bring the Memory back. The
    // query embeds before the first pass, whose admission prefix travels with it.
    const denseOnlyQuery = "zqxvwerty plumbulous";
    const providerSearch = await expectJson<Array<{ memory: { id: string } }>>(
      await embeddingApp.request(
        jsonRequest(`/api/v1/memories?q=${encodeURIComponent(denseOnlyQuery)}`, {
          headers: aliceHeaders,
        }),
      ),
      200,
      "search with an embedding provider",
    );
    assert.deepEqual(embeddedTexts.at(-1), [denseOnlyQuery], "the search embedded its query");
    assert.ok(
      providerSearch.some((result) => result.memory.id === chunked.id),
      "the dense channel finds the embedded Memory without a lexical match",
    );
  } finally {
    await inspector.end();
    await maintenanceDatabase.close();
  }

  // A Workers request pool never evicts its idle client, so a provider call longer
  // than pg's default 10-second idle timeout reuses the request's one connection.
  const requestPool = createRequestPostgresDatabase(
    { connectionString: runtimeConnection(adminUrl, runtimeRole, runtimePassword) },
    { pipeline: true },
  );
  try {
    const backend = () =>
      requestPool.transaction(
        async (transaction) =>
          (await transaction.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
    const first = await backend();
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    assert.equal(await backend(), first, "the request pool kept its one connection while idle");
  } finally {
    await requestPool.close();
  }

  assert.equal(alice.userId !== bob.userId, true, "smoke Actors must resolve to distinct Users");
  console.log(
    "Memory Core smoke passed: schema, RLS, governance, retrieval, chunk reuse, and degraded mode",
  );
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

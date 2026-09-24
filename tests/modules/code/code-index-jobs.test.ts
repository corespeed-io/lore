import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PostgresDatabase } from "@corespeed/lore-core";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { CodeIndexValidationError } from "@/modules/code/indexing/errors";
import type { CodeIndexMaintenanceLog } from "@/modules/code/indexing/maintenance";
import {
  classifyCodeIndexFailure,
  createCodeIndexMaintenanceModule,
} from "@/modules/code/indexing/maintenance";
import type { ConfiguredCodeRepositories } from "@/modules/code/indexing/queue";
import {
  CODE_REPOSITORY_NOT_CONFIGURED,
  configuredCodeRepositoriesFromEnvironment,
  createCodeIndexQueueModule,
} from "@/modules/code/indexing/queue";
import { createCodeIndexModule } from "@/modules/code/indexing/service";
import { createApi } from "@/server/api/app";
import { createAccessModule } from "@/server/auth/access";
import type { ActorContext } from "@/server/auth/actor-context";
import type { MemoryTestContext } from "../../support/memory-context";
import { createMemoryTestContext } from "../../support/memory-context";

const execFileAsync = promisify(execFile);
const REPOSITORY_KEY = "corespeed/job-lifecycle";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

async function committedRepository(files: Record<string, string>) {
  const repositoryPath = await mkdtemp(join(tmpdir(), "lore-code-index-jobs-"));
  onTestFinished(async () => {
    await rm(repositoryPath, { force: true, recursive: true });
  });
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repositoryPath, path)), { recursive: true });
    await writeFile(join(repositoryPath, path), content, "utf8");
  }
  await execFileAsync("git", ["-C", repositoryPath, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    repositoryPath,
    "-c",
    "user.name=Lore Test",
    "-c",
    "user.email=lore@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const { stdout } = await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
  return { repositoryPath, commitOid: stdout.trim() };
}

function registry(
  repositoryPath: string,
  workspaceIds?: readonly string[],
): ConfiguredCodeRepositories {
  return {
    [REPOSITORY_KEY]: {
      displayName: "Job lifecycle",
      repositoryPath,
      ...(workspaceIds ? { workspaceIds } : {}),
    },
  };
}

interface JobRow {
  status: string;
  attempt_count: number;
  last_error: string | null;
  requested_by_user_id: string;
  requested_by_agent_id: string | null;
  repository_path: string;
  completed_at: Date | string | null;
}

async function jobRow(context: MemoryTestContext, jobId: string): Promise<JobRow | undefined> {
  const result = await context.adminDatabase.transaction((transaction) =>
    transaction.query<JobRow>(
      `SELECT status::text, attempt_count, last_error, requested_by_user_id,
         requested_by_agent_id, repository_path, completed_at
       FROM code_index_jobs
       WHERE id = $1`,
      [jobId],
    ),
  );
  return result.rows[0];
}

async function writerAgent(context: MemoryTestContext) {
  const access = createAccessModule(context.database);
  const agent = await access.createAgentForWorkspace(context.alice, {
    name: "Indexing assistant",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(context.alice, agent.id);
  const actor = await access.authenticateAgent(credential.token, context.alice.workspaceId);
  if (!actor) throw new Error("Expected the writer Agent to authenticate");
  return { access, agent, actor };
}

test("an exhausted lease that expired on its final attempt becomes dead instead of processing forever", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/index.ts": "export const exhausted = true;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE code_index_jobs
       SET status = 'processing', attempt_count = max_attempts,
           lease_token = gen_random_uuid(), leased_at = now() - interval '2 hours'
       WHERE id = $1`,
      [queued.id],
    ),
  );

  const maintenance = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories: registry(repositoryPath),
  });
  await expect(maintenance.run()).resolves.toEqual({ status: "idle" });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "dead",
    last_error: "Code Index job lease expired during its final attempt",
    completed_at: expect.anything(),
  });
});

test("a lease that is still valid on its final attempt is not retired", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/index.ts": "export const running = true;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE code_index_jobs
       SET status = 'processing', attempt_count = max_attempts,
           lease_token = gen_random_uuid(), leased_at = now()
       WHERE id = $1`,
      [queued.id],
    ),
  );

  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
      repositories: registry(repositoryPath),
    }).run(queued.id),
  ).resolves.toEqual({ status: "idle" });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({ status: "processing" });
});

test("re-enqueueing a dead job re-arms it for the new requester", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/rearm.ts": 'export const rearmMarker = "indexed after re-arm";\n',
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE code_index_jobs
       SET status = 'dead', attempt_count = max_attempts, completed_at = now(),
           available_at = now() + interval '1 hour', last_error = 'earlier failure'
       WHERE id = $1`,
      [queued.id],
    ),
  );

  const rearmed = await queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid });

  expect(rearmed).toMatchObject({
    id: queued.id,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    completedAt: null,
  });
  expect(new Date(rearmed.availableAt).getTime()).toBeLessThanOrEqual(Date.now());
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    requested_by_user_id: context.bob.userId,
    requested_by_agent_id: null,
  });
  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
      repositories: registry(repositoryPath),
    }).run(queued.id),
  ).resolves.toMatchObject({ status: "complete", jobId: queued.id });
  await expect(
    createCodeIndexModule(context.database).search(context.bob, {
      repositoryKey: REPOSITORY_KEY,
      commitOid,
      query: "rearmMarker",
    }),
  ).resolves.toMatchObject([{ path: "src/rearm.ts" }]);
});

test("re-enqueueing a runnable job leaves its requester and retry state untouched", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/pending.ts": "export const pending = true;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE code_index_jobs
       SET attempt_count = 2, last_error = 'Code Index processing failed'
       WHERE id = $1`,
      [queued.id],
    ),
  );

  await expect(
    queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid }),
  ).resolves.toMatchObject({ id: queued.id, attemptCount: 2 });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "pending",
    requested_by_user_id: context.alice.userId,
    last_error: "Code Index processing failed",
  });
});

test("a disabled then deleted Agent's job never runs and a human member can re-enqueue the commit", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/agent.ts": 'export const agentMarker = "indexed by a human";\n',
  });
  const repositories = registry(repositoryPath);
  const queue = createCodeIndexQueueModule(context.database, repositories);
  const { access, agent, actor } = await writerAgent(context);
  const queued = await queue.enqueue(actor, { repositoryKey: REPOSITORY_KEY, commitOid });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "pending",
    requested_by_agent_id: agent.id,
  });
  const maintenance = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories,
  });

  await access.updateAgent(context.alice, agent.id, { status: "disabled" });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "cancelled",
    last_error: "Requesting Agent was disabled",
  });
  await expect(maintenance.run()).resolves.toEqual({ status: "idle" });

  await expect(access.deleteAgent(context.alice, agent.id)).resolves.toBe("deleted");
  // The foreign key cleared the Agent, but the job stays cancelled rather than
  // becoming a request by the Agent's human owner.
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "cancelled",
    requested_by_user_id: context.alice.userId,
    requested_by_agent_id: null,
  });
  await expect(maintenance.run(queued.id)).resolves.toEqual({ status: "idle" });
  await expect(maintenance.run()).resolves.toEqual({ status: "idle" });

  await expect(
    queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid }),
  ).resolves.toMatchObject({ id: queued.id, status: "pending", attemptCount: 0 });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    requested_by_user_id: context.bob.userId,
    requested_by_agent_id: null,
  });
  await expect(maintenance.run(queued.id)).resolves.toMatchObject({ status: "complete" });
});

test("deleting an Agent cancels its jobs even without disabling it first", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/direct.ts": "export const direct = true;\n",
  });
  const repositories = registry(repositoryPath);
  const queue = createCodeIndexQueueModule(context.database, repositories);
  const { agent, actor } = await writerAgent(context);
  const queued = await queue.enqueue(actor, { repositoryKey: REPOSITORY_KEY, commitOid });

  await context.database.transaction(async (transaction) => {
    await transaction.query(
      `SELECT set_config('lore.workspace_id', $1, true), set_config('lore.user_id', $2, true)`,
      [context.alice.workspaceId, context.alice.userId],
    );
    await transaction.query("DELETE FROM agents WHERE id = $1", [agent.id]);
  });

  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "cancelled",
    last_error: "Requesting Agent was deleted",
    requested_by_agent_id: null,
  });
  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, { repositories }).run(),
  ).resolves.toEqual({ status: "idle" });
});

test("disabling an Agent mid-job fences the running worker, which reports lost", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/fenced.ts": "export const fenced = true;\n",
  });
  const repositories = registry(repositoryPath);
  const queue = createCodeIndexQueueModule(context.database, repositories);
  const { access, agent, actor } = await writerAgent(context);
  const queued = await queue.enqueue(actor, { repositoryKey: REPOSITORY_KEY, commitOid });
  let transactions = 0;
  // Disable the Agent between the claim and the first indexing transaction.
  const interrupted: PostgresDatabase = {
    transaction: async (use) => {
      transactions += 1;
      if (transactions === 2) {
        await access.updateAgent(context.alice, agent.id, { status: "disabled" });
      }
      return context.maintenanceDatabase.transaction(use);
    },
  };
  const logs: CodeIndexMaintenanceLog[] = [];
  const maintenance = createCodeIndexMaintenanceModule(interrupted, {
    repositories,
    logger: (entry) => logs.push(entry),
  });

  await expect(maintenance.run(queued.id)).resolves.toEqual({
    status: "lost",
    jobId: queued.id,
  });
  expect(logs).toMatchObject([{ event: "job_lost", jobId: queued.id }]);
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "cancelled",
    last_error: "Requesting Agent was disabled",
  });
});

test("a job whose Agent lost its grant is taken over by the next authorized request", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/orphan.ts": "export const orphan = true;\n",
  });
  const repositories = registry(repositoryPath);
  const queue = createCodeIndexQueueModule(context.database, repositories);
  const { access, agent, actor } = await writerAgent(context);
  const queued = await queue.enqueue(actor, { repositoryKey: REPOSITORY_KEY, commitOid });
  const maintenance = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories,
  });

  await access.revokeAgentGrant(context.alice, agent.id);
  await expect(maintenance.run(queued.id)).resolves.toEqual({ status: "idle" });
  await expect(
    queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid }),
  ).resolves.toMatchObject({ id: queued.id, status: "pending" });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    requested_by_user_id: context.bob.userId,
    requested_by_agent_id: null,
  });
  await expect(maintenance.run(queued.id)).resolves.toMatchObject({ status: "complete" });
});

test("a commit missing from the repository fails terminally on its first attempt", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath } = await committedRepository({ "src/index.ts": "export const a = 1;\n" });
  const repositories = registry(repositoryPath);
  const queue = createCodeIndexQueueModule(context.database, repositories);
  const queued = await queue.enqueue(context.alice, {
    repositoryKey: REPOSITORY_KEY,
    commitOid: "f".repeat(40),
  });
  const logs: CodeIndexMaintenanceLog[] = [];

  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
      repositories,
      logger: (entry) => logs.push(entry),
    }).run(queued.id),
  ).resolves.toEqual({ status: "dead", jobId: queued.id });

  const row = await jobRow(context, queued.id);
  expect(row).toMatchObject({
    status: "dead",
    attempt_count: 1,
    last_error: "Unable to read the requested Git revision",
  });
  expect(logs).toEqual([
    {
      event: "job_dead",
      jobId: queued.id,
      attempt: 1,
      errorClass: "CodeIndexValidationError",
    },
  ]);
  expect(JSON.stringify(logs)).not.toContain(repositoryPath);
  await expect(
    createCodeIndexModule(context.database).getIndexJob(context.alice, { jobId: queued.id }),
  ).resolves.toMatchObject({
    status: "dead",
    lastError: "Unable to read the requested Git revision",
  });
});

test("an OID/content conflict fails terminally instead of spending its retries", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/conflict.ts": "export const committed = true;\n",
  });
  const repositories = registry(repositoryPath);
  await createCodeIndexModule(context.database).indexRevision(context.alice, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Job lifecycle",
    commitOid,
    files: [{ path: "src/conflict.ts", content: "export const different = true;\n" }],
  });
  const queued = await createCodeIndexQueueModule(context.database, repositories).enqueue(
    context.alice,
    { repositoryKey: REPOSITORY_KEY, commitOid },
  );

  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, { repositories }).run(queued.id),
  ).resolves.toEqual({ status: "dead", jobId: queued.id });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    attempt_count: 1,
    last_error: "The commit OID is already indexed with different source or Git tree evidence",
  });
});

test("a transient failure keeps the retry budget and a content-free error", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/transient.ts": "export const transient = true;\n",
  });
  const repositories = registry(repositoryPath);
  const queued = await createCodeIndexQueueModule(context.database, repositories).enqueue(
    context.alice,
    { repositoryKey: REPOSITORY_KEY, commitOid },
  );
  let failed = false;
  const flaky: PostgresDatabase = {
    transaction: (use) =>
      context.maintenanceDatabase.transaction((transaction) =>
        use({
          query: (sql, params) => {
            if (!failed && sql.includes("INSERT INTO code_revisions")) {
              failed = true;
              throw new Error(`connection reset while reading ${repositoryPath}`);
            }
            return transaction.query(sql, params);
          },
        }),
      ),
  };
  const logs: CodeIndexMaintenanceLog[] = [];

  await expect(
    createCodeIndexMaintenanceModule(flaky, {
      repositories,
      logger: (entry) => logs.push(entry),
    }).run(queued.id),
  ).resolves.toEqual({ status: "retry", jobId: queued.id, retryAfterSeconds: 30 });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "pending",
    attempt_count: 1,
    last_error: "Code Index processing failed",
  });
  expect(logs).toEqual([{ event: "job_retry", jobId: queued.id, attempt: 1, errorClass: "Error" }]);
});

test("failure classification keeps deterministic messages only when they reveal no server path", () => {
  const serverPath = "/srv/operator/private-repository";
  expect(
    classifyCodeIndexFailure(
      Object.assign(
        new Error("Code Index generation is incomplete (expected 2, actual 1, missing files 1)"),
        { code: "P0001" },
      ),
      [serverPath],
    ),
  ).toEqual({
    terminal: true,
    detail: "Code Index generation is incomplete (expected 2, actual 1, missing files 1)",
    errorClass: "Error",
    sqlState: "P0001",
  });
  expect(
    classifyCodeIndexFailure(new CodeIndexValidationError(`cannot open ${serverPath}`), [
      serverPath,
    ]),
  ).toEqual({
    terminal: true,
    detail: "Code Index processing failed",
    errorClass: "CodeIndexValidationError",
  });
  expect(
    classifyCodeIndexFailure(Object.assign(new Error("deadlock detected"), { code: "40P01" }), [
      serverPath,
    ]),
  ).toEqual({
    terminal: false,
    detail: "Code Index processing failed",
    errorClass: "Error",
    sqlState: "40P01",
  });
  expect(
    classifyCodeIndexFailure(Object.assign(new Error("Some other raise"), { code: "P0001" }), [
      serverPath,
    ]),
  ).toMatchObject({ terminal: false });
});

test("the registry binds repositories to Workspaces and fails closed without a binding", () => {
  const workspaceIds = ["20000000-0000-4000-8000-000000000001"];
  const encoded = JSON.stringify({
    "corespeed/bound": {
      displayName: "Bound",
      repositoryPath: "/srv/bound",
      workspaceIds: ["20000000-0000-4000-8000-000000000001".toUpperCase()],
    },
    "corespeed/unbound": { displayName: "Unbound", repositoryPath: "/srv/unbound" },
  });
  const warnings: string[] = [];

  expect(
    configuredCodeRepositoriesFromEnvironment(
      { AUTH_MODE: "proxy", LORE_CODE_REPOSITORIES: encoded },
      (message) => warnings.push(message),
    ),
  ).toEqual({
    "corespeed/bound": { displayName: "Bound", repositoryPath: "/srv/bound", workspaceIds },
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain("/srv/unbound");
  for (const authMode of [undefined, "", "invalid"]) {
    expect(
      Object.keys(
        configuredCodeRepositoriesFromEnvironment({
          AUTH_MODE: authMode,
          LORE_CODE_REPOSITORIES: encoded,
        }),
      ),
    ).toEqual(["corespeed/bound"]);
  }
  for (const authMode of ["password", "none"]) {
    expect(
      configuredCodeRepositoriesFromEnvironment({
        AUTH_MODE: authMode,
        LORE_CODE_REPOSITORIES: encoded,
      }),
    ).toMatchObject({
      "corespeed/bound": { workspaceIds },
      "corespeed/unbound": { displayName: "Unbound", repositoryPath: "/srv/unbound" },
    });
  }
  for (const workspaceIdsValue of [[], ["not-a-uuid"], "20000000-0000-4000-8000-000000000001"]) {
    expect(() =>
      configuredCodeRepositoriesFromEnvironment({
        AUTH_MODE: "password",
        LORE_CODE_REPOSITORIES: JSON.stringify({
          "corespeed/bad": {
            displayName: "Bad",
            repositoryPath: "/srv/bad",
            workspaceIds: workspaceIdsValue,
          },
        }),
      }),
    ).toThrow(CodeIndexValidationError);
  }
});

async function enqueueError(
  repositories: ConfiguredCodeRepositories,
  context: MemoryTestContext,
  actor: ActorContext,
  repositoryKey: string,
) {
  try {
    await createCodeIndexQueueModule(context.database, repositories).enqueue(actor, {
      repositoryKey,
      commitOid: "a".repeat(40),
    });
  } catch (error) {
    return error;
  }
  throw new Error("Expected enqueue to be refused");
}

test("a Workspace outside the allowlist gets exactly the unconfigured-key refusal", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/bound.ts": "export const bound = true;\n",
  });
  const encoded = JSON.stringify({
    [REPOSITORY_KEY]: {
      displayName: "Job lifecycle",
      repositoryPath,
      workspaceIds: [context.alice.workspaceId],
    },
  });
  const proxyRegistry = configuredCodeRepositoriesFromEnvironment({
    AUTH_MODE: "proxy",
    LORE_CODE_REPOSITORIES: encoded,
  });

  await expect(
    createCodeIndexQueueModule(context.database, proxyRegistry).enqueue(context.alice, {
      repositoryKey: REPOSITORY_KEY,
      commitOid,
    }),
  ).resolves.toMatchObject({ repositoryKey: REPOSITORY_KEY, status: "pending" });

  const denied = await enqueueError(proxyRegistry, context, context.carol, REPOSITORY_KEY);
  const unconfigured = await enqueueError(
    proxyRegistry,
    context,
    context.carol,
    "corespeed/not-configured",
  );
  expect(denied).toBeInstanceOf(CodeIndexValidationError);
  expect(unconfigured).toBeInstanceOf(CodeIndexValidationError);
  expect(denied).toMatchObject({ message: CODE_REPOSITORY_NOT_CONFIGURED, status: 400 });
  expect({ ...(denied as object), message: (denied as Error).message }).toEqual({
    ...(unconfigured as object),
    message: (unconfigured as Error).message,
  });

  // Over HTTP the two refusals are byte-identical.
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "code-jobs-carol";
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `INSERT INTO identities (id, user_id, provider, subject)
       VALUES ($1, $2, 'local', $3)`,
      [crypto.randomUUID(), context.carol.userId, process.env.LORE_LOCAL_SUBJECT],
    ),
  );
  const app = createApi({
    database: () => context.database,
    memoryOptions: () => ({}),
    codeRepositories: () => proxyRegistry,
  });
  const post = (repositoryKey: string) =>
    app.request(
      new Request("http://lore.local/api/v1/code/index-jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lore-workspace-id": context.carol.workspaceId,
        },
        body: JSON.stringify({ repositoryKey, commitOid }),
      }),
    );
  const deniedResponse = await post(REPOSITORY_KEY);
  const unconfiguredResponse = await post("corespeed/not-configured");
  expect(deniedResponse.status).toBe(400);
  expect(unconfiguredResponse.status).toBe(deniedResponse.status);
  const deniedBody = await deniedResponse.text();
  expect(deniedBody).toBe(await unconfiguredResponse.text());
  expect(deniedBody).not.toContain(repositoryPath);
});

test("an unbound entry is refused in proxy mode and served in password mode", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/unbound.ts": "export const unbound = true;\n",
  });
  const encoded = JSON.stringify({
    [REPOSITORY_KEY]: { displayName: "Job lifecycle", repositoryPath },
  });

  const proxyError = await enqueueError(
    configuredCodeRepositoriesFromEnvironment({
      AUTH_MODE: "proxy",
      LORE_CODE_REPOSITORIES: encoded,
    }),
    context,
    context.alice,
    REPOSITORY_KEY,
  );
  expect(proxyError).toMatchObject({ message: CODE_REPOSITORY_NOT_CONFIGURED });

  const passwordRegistry = configuredCodeRepositoriesFromEnvironment({
    AUTH_MODE: "password",
    LORE_CODE_REPOSITORIES: encoded,
  });
  await expect(
    createCodeIndexQueueModule(context.database, passwordRegistry).enqueue(context.carol, {
      repositoryKey: REPOSITORY_KEY,
      commitOid,
    }),
  ).resolves.toMatchObject({ status: "pending" });
});

test("the worker indexes from its own registry and ignores a tampered job path", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/trusted.ts": 'export const trustedMarker = "from the operator registry";\n',
  });
  const decoy = await committedRepository({ "src/decoy.ts": "export const decoy = true;\n" });
  const repositories = registry(repositoryPath, [context.alice.workspaceId]);
  const queued = await createCodeIndexQueueModule(context.database, repositories).enqueue(
    context.alice,
    { repositoryKey: REPOSITORY_KEY, commitOid },
  );
  // A compromised request role could rewrite the stored path; the worker must not read it.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE code_index_jobs SET repository_path = $1 WHERE id = $2", [
      decoy.repositoryPath,
      queued.id,
    ]),
  );

  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, { repositories }).run(queued.id),
  ).resolves.toMatchObject({ status: "complete", jobId: queued.id });
  await expect(
    createCodeIndexModule(context.database).search(context.alice, {
      repositoryKey: REPOSITORY_KEY,
      commitOid,
      query: "trustedMarker",
    }),
  ).resolves.toMatchObject([{ path: "src/trusted.ts" }]);
});

test("a key removed from the worker registry or no longer bound to the Workspace fails terminally", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/removed.ts": "export const removed = true;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const removedJob = await queue.enqueue(context.alice, {
    repositoryKey: REPOSITORY_KEY,
    commitOid,
  });
  const logs: CodeIndexMaintenanceLog[] = [];
  const withoutKey = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories: { "corespeed/other": { displayName: "Other", repositoryPath: "/srv/other" } },
    logger: (entry) => logs.push(entry),
  });

  await expect(withoutKey.run(removedJob.id)).resolves.toEqual({
    status: "dead",
    jobId: removedJob.id,
  });
  await expect(jobRow(context, removedJob.id)).resolves.toMatchObject({
    status: "dead",
    attempt_count: 1,
    last_error: CODE_REPOSITORY_NOT_CONFIGURED,
  });

  // Re-arm, then run under a registry that binds the key to another Workspace.
  await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  const rebound = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories: registry(repositoryPath, [context.carol.workspaceId]),
    logger: (entry) => logs.push(entry),
  });
  await expect(rebound.run(removedJob.id)).resolves.toMatchObject({ status: "dead" });
  await expect(jobRow(context, removedJob.id)).resolves.toMatchObject({
    last_error: CODE_REPOSITORY_NOT_CONFIGURED,
  });
  expect(logs.map((entry) => entry.event)).toEqual(["job_dead", "job_dead"]);
  expect(JSON.stringify(logs)).not.toContain(repositoryPath);
});

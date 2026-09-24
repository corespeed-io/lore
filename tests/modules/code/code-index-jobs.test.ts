import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PostgresDatabase } from "@corespeed/lore-core";
import { afterEach, expect, onTestFinished, test } from "vitest";
import {
  CodeIndexValidationError,
  CodeRepositoryUnavailableError,
  GitOperationalError,
} from "@/modules/code/indexing/errors";
import { gitFailure, resolveGitCommit } from "@/modules/code/indexing/git";
import type { CodeIndexMaintenanceLog } from "@/modules/code/indexing/maintenance";
import {
  cancelSupersededCodeIndexJobs,
  classifyCodeIndexFailure,
  createCodeIndexMaintenanceModule,
} from "@/modules/code/indexing/maintenance";
import {
  CODE_INDEX_REVISION,
  SUPERSEDED_CODE_INDEX_REVISIONS,
} from "@/modules/code/indexing/protocol";
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
import { installActorContext } from "@/server/auth/actor-context";
import type { MemoryTestContext } from "../../support/memory-context";
import { createMemoryTestContext } from "../../support/memory-context";

const execFileAsync = promisify(execFile);
const REPOSITORY_KEY = "corespeed/job-lifecycle";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "lore-code-index-jobs-"));
  onTestFinished(async () => {
    await rm(path, { force: true, recursive: true });
  });
  return path;
}

async function committedRepository(files: Record<string, string>) {
  const repositoryPath = await temporaryDirectory();
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  return { repositoryPath, commitOid: await commitFiles(repositoryPath, files) };
}

async function commitFiles(repositoryPath: string, files: Record<string, string>) {
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
  return stdout.trim();
}

/** Clears a retried job's backoff so the next run can claim it at once. */
async function claimableNow(context: MemoryTestContext, jobId: string): Promise<void> {
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      "UPDATE code_index_jobs SET available_at = now() WHERE id = $1 AND status = 'pending'",
      [jobId],
    ),
  );
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

test("re-enqueueing a dead job past its cooldown re-arms it for the new requester", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/rearm.ts": 'export const rearmMarker = "indexed after re-arm";\n',
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE code_index_jobs
       SET status = 'dead', attempt_count = max_attempts,
           completed_at = now() - interval '16 minutes',
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

test("a dead job re-arms only after its 15-minute cooldown, a cancelled job at once", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/cooldown.ts": "export const cooldown = true;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  const endAs = (status: "cancelled" | "dead", age: string) =>
    context.adminDatabase.transaction((transaction) =>
      transaction.query(
        `UPDATE code_index_jobs
         SET status = $2::code_index_job_status, attempt_count = max_attempts,
             completed_at = now() - $3::interval, last_error = 'earlier failure'
         WHERE id = $1`,
        [queued.id, status, age],
      ),
    );

  // Inside the cooldown the dead job comes back as it is, still Alice's.
  for (const age of ["0 seconds", "14 minutes 59 seconds"]) {
    await endAs("dead", age);
    await expect(
      queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid }),
      age,
    ).resolves.toMatchObject({
      id: queued.id,
      status: "dead",
      attemptCount: 5,
      lastError: "earlier failure",
    });
    await expect(jobRow(context, queued.id)).resolves.toMatchObject({
      status: "dead",
      requested_by_user_id: context.alice.userId,
      last_error: "earlier failure",
    });
  }

  // Past it, the same request re-arms the job for Bob with a fresh budget.
  await endAs("dead", "15 minutes 1 second");
  await expect(
    queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid }),
  ).resolves.toMatchObject({ id: queued.id, status: "pending", attemptCount: 0, lastError: null });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    requested_by_user_id: context.bob.userId,
  });

  // A cancelled job never waits.
  await endAs("cancelled", "0 seconds");
  await expect(
    queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid }),
  ).resolves.toMatchObject({ id: queued.id, status: "pending", attemptCount: 0, lastError: null });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    requested_by_user_id: context.alice.userId,
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

test("only a write-authorized Actor of the repository's Workspace can enqueue or re-arm", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/guard.ts": "export const guard = 1;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE code_index_jobs
       SET status = 'dead', attempt_count = max_attempts,
           completed_at = now() - interval '1 hour'
       WHERE id = $1`,
      [queued.id],
    ),
  );
  const access = createAccessModule(context.database);
  const reader = await access.createAgentForWorkspace(context.alice, {
    name: "Read-only assistant",
    permission: "read",
  });
  const readerActor = await access.authenticateAgent(
    (await access.issueAgentCredential(context.alice, reader.id)).token,
    context.alice.workspaceId,
  );
  if (!readerActor) throw new Error("Expected the read-only Agent to authenticate");
  // The context a writer Agent held before its grant was revoked.
  const { agent: revoked, actor: revokedActor } = await writerAgent(context);
  await access.revokeAgentGrant(context.alice, revoked.id);
  await context.suspendMembership(context.bob);

  // The SECURITY DEFINER function bypasses RLS, so its own checks are the only guard:
  // no Actor here may re-arm the dead job, take it over, or change its repository path.
  for (const [label, actor] of [
    ["read-only Agent", readerActor],
    ["Agent whose grant was revoked", revokedActor],
    ["suspended member", context.bob],
    ["member of another Workspace", context.carol],
  ] as const) {
    await expect(
      context.database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        return transaction.query("SELECT lore.enqueue_code_index_job($1, $2, $3, NULL, $4)", [
          queued.repositoryId,
          "/srv/elsewhere",
          commitOid,
          CODE_INDEX_REVISION,
        ]);
      }),
      label,
    ).rejects.toMatchObject({ code: "42501" });
  }
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "dead",
    requested_by_user_id: context.alice.userId,
    requested_by_agent_id: null,
    repository_path: repositoryPath,
  });
  // The shared requester predicate would reveal Membership and grant state, so the
  // request role cannot call it directly.
  await expect(
    context.database.transaction(async (transaction) => {
      await installActorContext(transaction, context.alice);
      return transaction.query("SELECT lore.code_index_requester_can_run($1, $2, NULL)", [
        context.carol.workspaceId,
        context.carol.userId,
      ]);
    }),
  ).rejects.toMatchObject({ code: "42501" });
});

test("the sweep cancels jobs an older app instance enqueued for a superseded indexer", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/superseded.ts": "export const superseded = true;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const current = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  const jobOfRevision = (indexerRevision: string) =>
    context.adminDatabase.transaction(async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        `INSERT INTO code_index_jobs (
           id, workspace_id, repository_id, repository_path, commit_oid, indexer_revision,
           requested_by_user_id
         )
         SELECT gen_random_uuid(), workspace_id, repository_id, repository_path, commit_oid,
                $2, requested_by_user_id
         FROM code_index_jobs WHERE id = $1
         RETURNING id`,
        [current.id, indexerRevision],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("Expected the job to be inserted");
      return id;
    });
  const retired = SUPERSEDED_CODE_INDEX_REVISIONS[0];
  if (!retired) throw new Error("Expected a superseded indexer revision");
  // What an app instance still running the previous CODE_INDEX_REVISION writes during
  // a rolling deploy: a pending job no worker of this revision will ever claim.
  const older = await jobOfRevision(retired);
  // What a newer release enqueues while this worker is still sweeping during a later
  // rollout: a revision this code does not know, which only the newer worker claims.
  const newer = await jobOfRevision("a-later-indexer-revision");

  expect(SUPERSEDED_CODE_INDEX_REVISIONS).not.toContain(CODE_INDEX_REVISION);
  await expect(cancelSupersededCodeIndexJobs(context.maintenanceDatabase)).resolves.toBe(1);
  await expect(jobRow(context, older)).resolves.toMatchObject({
    status: "cancelled",
    last_error: "Superseded by a newer Code Index revision",
  });
  await expect(jobRow(context, current.id)).resolves.toMatchObject({ status: "pending" });
  await expect(jobRow(context, newer)).resolves.toMatchObject({ status: "pending" });
  // The request role cannot run it.
  await expect(
    context.database.transaction(async (transaction) => {
      await installActorContext(transaction, context.alice);
      return transaction.query("SELECT lore.cancel_superseded_code_index_jobs(ARRAY['x'])");
    }),
  ).rejects.toMatchObject({ code: "42501" });
});

test("re-enqueue honours an orphaned job's live lease for up to an hour", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/fence.ts": "export const fence = true;\n",
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const { access, agent, actor } = await writerAgent(context);
  const queued = await queue.enqueue(actor, { repositoryKey: REPOSITORY_KEY, commitOid });
  await access.revokeAgentGrant(context.alice, agent.id);
  const leaseAge = (age: string) =>
    context.adminDatabase.transaction((transaction) =>
      transaction.query(
        `UPDATE code_index_jobs
         SET status = 'processing', lease_token = gen_random_uuid(),
             leased_at = now() - $2::interval, attempt_count = 1
         WHERE id = $1`,
        [queued.id, age],
      ),
    );

  // A worker may still hold a 30-minute-old lease: taking the job over would let two
  // workers index it at once.
  await leaseAge("30 minutes");
  await queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "processing",
    requested_by_agent_id: agent.id,
  });

  // Past the longest possible lease nobody can still hold it.
  await leaseAge("2 hours");
  await expect(
    queue.enqueue(context.bob, { repositoryKey: REPOSITORY_KEY, commitOid }),
  ).resolves.toMatchObject({ id: queued.id, status: "pending", attemptCount: 0 });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    requested_by_user_id: context.bob.userId,
    requested_by_agent_id: null,
  });
});

test("a commit not yet fetched into the local clone retries and indexes once it arrives", async () => {
  const context = await createMemoryTestContext();
  const origin = await committedRepository({ "src/early.ts": "export const early = 1;\n" });
  const clonePath = join(await temporaryDirectory(), "clone");
  await execFileAsync("git", ["clone", "--quiet", origin.repositoryPath, clonePath]);
  const lateCommit = await commitFiles(origin.repositoryPath, {
    "src/late.ts": 'export const lateMarker = "fetched after enqueue";\n',
  });
  const repositories = registry(clonePath);
  const queued = await createCodeIndexQueueModule(context.database, repositories).enqueue(
    context.alice,
    { repositoryKey: REPOSITORY_KEY, commitOid: lateCommit },
  );
  const logs: CodeIndexMaintenanceLog[] = [];
  const maintenance = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories,
    logger: (entry) => logs.push(entry),
  });

  await expect(maintenance.run(queued.id)).resolves.toEqual({
    status: "retry",
    jobId: queued.id,
    retryAfterSeconds: 30,
  });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "pending",
    attempt_count: 1,
    last_error: "Unable to read the requested Git revision",
  });

  await execFileAsync("git", ["-C", clonePath, "fetch", "--quiet", "origin"]);
  await claimableNow(context, queued.id);
  await expect(maintenance.run(queued.id)).resolves.toMatchObject({
    status: "complete",
    jobId: queued.id,
  });
  await expect(
    createCodeIndexModule(context.database).search(context.alice, {
      repositoryKey: REPOSITORY_KEY,
      commitOid: lateCommit,
      query: "lateMarker",
    }),
  ).resolves.toMatchObject([{ path: "src/late.ts" }]);
  expect(logs).toEqual([
    { event: "job_retry", jobId: queued.id, attempt: 1, errorClass: "GitOperationalError" },
    { event: "job_complete", jobId: queued.id, attempt: 2 },
  ]);
  expect(JSON.stringify(logs)).not.toContain(clonePath);
});

test("a commit that never arrives backs off through its retry budget, then ends dead", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath } = await committedRepository({ "src/index.ts": "export const a = 1;\n" });
  const repositories = registry(repositoryPath);
  const queued = await createCodeIndexQueueModule(context.database, repositories).enqueue(
    context.alice,
    { repositoryKey: REPOSITORY_KEY, commitOid: "f".repeat(40) },
  );
  const logs: CodeIndexMaintenanceLog[] = [];
  const maintenance = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories,
    logger: (entry) => logs.push(entry),
  });

  for (const [attempt, retryAfterSeconds] of [30, 60, 120, 240].entries()) {
    await expect(maintenance.run(queued.id)).resolves.toEqual({
      status: "retry",
      jobId: queued.id,
      retryAfterSeconds,
    });
    await expect(jobRow(context, queued.id)).resolves.toMatchObject({
      status: "pending",
      attempt_count: attempt + 1,
      last_error: "Unable to read the requested Git revision",
    });
    // The backoff holds: the job is not claimable again until it elapses.
    await expect(maintenance.run(queued.id)).resolves.toEqual({ status: "idle" });
    await claimableNow(context, queued.id);
  }
  await expect(maintenance.run(queued.id)).resolves.toEqual({ status: "dead", jobId: queued.id });

  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "dead",
    attempt_count: 5,
    last_error: "Unable to read the requested Git revision",
    completed_at: expect.anything(),
  });
  expect(logs.map((entry) => [entry.event, entry.attempt, entry.errorClass])).toEqual([
    ["job_retry", 1, "GitOperationalError"],
    ["job_retry", 2, "GitOperationalError"],
    ["job_retry", 3, "GitOperationalError"],
    ["job_retry", 4, "GitOperationalError"],
    ["job_dead", 5, "GitOperationalError"],
  ]);
  expect(JSON.stringify(logs)).not.toContain(repositoryPath);
  await expect(
    createCodeIndexModule(context.database).getIndexJob(context.alice, { jobId: queued.id }),
  ).resolves.toMatchObject({
    status: "dead",
    lastError: "Unable to read the requested Git revision",
  });
});

test("a repository path that does not resolve yet retries until the clone is in place", async () => {
  const context = await createMemoryTestContext();
  const origin = await committedRepository({
    "src/mounted.ts": 'export const mountedMarker = "read after the mount";\n',
  });
  const mountPath = join(await temporaryDirectory(), "not-mounted-yet");
  const repositories = registry(mountPath);
  const queued = await createCodeIndexQueueModule(context.database, repositories).enqueue(
    context.alice,
    { repositoryKey: REPOSITORY_KEY, commitOid: origin.commitOid },
  );
  const logs: CodeIndexMaintenanceLog[] = [];
  const maintenance = createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
    repositories,
    logger: (entry) => logs.push(entry),
  });

  await expect(maintenance.run(queued.id)).resolves.toMatchObject({ status: "retry" });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "pending",
    attempt_count: 1,
    last_error: "The configured repository is not available",
  });

  await execFileAsync("git", ["clone", "--quiet", origin.repositoryPath, mountPath]);
  await claimableNow(context, queued.id);
  await expect(maintenance.run(queued.id)).resolves.toMatchObject({ status: "complete" });
  expect(logs.map((entry) => entry.event)).toEqual(["job_retry", "job_complete"]);
  expect(JSON.stringify(logs)).not.toContain(mountPath);
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
  // A recognized retryable failure keeps its fixed message, still subject to the path guard.
  expect(
    classifyCodeIndexFailure(new CodeRepositoryUnavailableError(CODE_REPOSITORY_NOT_CONFIGURED), [
      serverPath,
    ]),
  ).toEqual({
    terminal: false,
    detail: CODE_REPOSITORY_NOT_CONFIGURED,
    errorClass: "CodeRepositoryUnavailableError",
  });
  expect(
    classifyCodeIndexFailure(new GitOperationalError(`cannot open ${serverPath}`), [serverPath]),
  ).toEqual({
    terminal: false,
    detail: "Code Index processing failed",
    errorClass: "GitOperationalError",
  });
});

test("a persisted failure detail carries no control characters and keeps the column bound", () => {
  // Committer-chosen repository-relative paths reach terminal messages verbatim.
  const hostile = "src/tab\there\nnew\u001b[2Jline\u007fdel\u009bcsi.ts";
  expect(
    classifyCodeIndexFailure(
      new CodeIndexValidationError(`Invalid repository-relative path: ${hostile}`),
      [],
    ),
  ).toMatchObject({
    terminal: true,
    detail: "Invalid repository-relative path: src/tab�here�new�[2Jline�del�csi.ts",
  });
  // The bound counts characters as SQL does, so an astral character is never split.
  const long = classifyCodeIndexFailure(
    new CodeIndexValidationError(`Duplicate source path: ${"\u{1F600}".repeat(1_200)}`),
    [],
  ).detail;
  expect(Array.from(long)).toHaveLength(1_000);
  expect(long.endsWith("\u{1F600}")).toBe(true);
  expect(
    classifyCodeIndexFailure(new CodeIndexValidationError(`\t${"x".repeat(1_500)}`), []).detail,
  ).toBe("x".repeat(1_000));
});

test("Git reads the local clone can outlive stay retryable while a present revision's failures end the job", async () => {
  const message = "Unable to read the requested Git revision";
  // Resource exhaustion, a killed process, or a missing path or Git executable.
  for (const cause of [
    { code: "EAGAIN" },
    { code: "EMFILE" },
    { code: "ENOENT" },
    { signal: "SIGKILL" },
  ]) {
    const failure = gitFailure(cause, message);
    expect(failure).toBeInstanceOf(GitOperationalError);
    expect(classifyCodeIndexFailure(failure, [])).toMatchObject({
      terminal: false,
      detail: message,
      errorClass: "GitOperationalError",
    });
  }
  // Git exiting non-zero over a present commit, or the output bound: identical on every retry.
  for (const cause of [
    { code: 128 },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    new Error("fatal: bad object"),
  ]) {
    const failure = gitFailure(cause, message);
    expect(failure).toBeInstanceOf(CodeIndexValidationError);
    expect(classifyCodeIndexFailure(failure, [])).toMatchObject({ terminal: true });
  }
  // A path that does not resolve yet, a directory that is not a repository yet (a mount
  // point before its volume), and a commit that is not fetched yet all retry.
  const { repositoryPath } = await committedRepository({ "src/a.ts": "export const a = 1;\n" });
  const unmounted = await temporaryDirectory();
  for (const [path, detail] of [
    [join(unmounted, "missing"), "The configured repository is not available"],
    [unmounted, message],
    [repositoryPath, message],
  ] as const) {
    const failure = await resolveGitCommit(path, "f".repeat(40)).then(
      () => new Error("Expected resolution to fail"),
      (error: unknown) => error,
    );
    expect(failure, path).toBeInstanceOf(GitOperationalError);
    expect(classifyCodeIndexFailure(failure, [path])).toEqual({
      terminal: false,
      detail,
      errorClass: "GitOperationalError",
    });
  }
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

test("a key this worker's registry does not serve to the Workspace retries until a worker does", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/rolled.ts": 'export const rolledMarker = "served after the registry update";\n',
  });
  const queue = createCodeIndexQueueModule(context.database, registry(repositoryPath));
  const queued = await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  const logs: CodeIndexMaintenanceLog[] = [];
  const worker = (repositories: ConfiguredCodeRepositories) =>
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, {
      repositories,
      logger: (entry) => logs.push(entry),
    });
  // A worker whose registry lacks the key, and one that binds it to another Workspace:
  // a rolling registry update, or workers with different registries.
  const withoutKey = worker({
    "corespeed/other": { displayName: "Other", repositoryPath: "/srv/other" },
  });
  const rebound = worker(registry(repositoryPath, [context.carol.workspaceId]));

  await expect(withoutKey.run(queued.id)).resolves.toEqual({
    status: "retry",
    jobId: queued.id,
    retryAfterSeconds: 30,
  });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "pending",
    attempt_count: 1,
    last_error: CODE_REPOSITORY_NOT_CONFIGURED,
  });
  await claimableNow(context, queued.id);
  await expect(rebound.run(queued.id)).resolves.toEqual({
    status: "retry",
    jobId: queued.id,
    retryAfterSeconds: 60,
  });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "pending",
    attempt_count: 2,
    last_error: CODE_REPOSITORY_NOT_CONFIGURED,
  });

  // Only the exhausted budget ends it dead.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE code_index_jobs
       SET attempt_count = max_attempts - 1, available_at = now()
       WHERE id = $1`,
      [queued.id],
    ),
  );
  await expect(withoutKey.run(queued.id)).resolves.toEqual({ status: "dead", jobId: queued.id });
  await expect(jobRow(context, queued.id)).resolves.toMatchObject({
    status: "dead",
    attempt_count: 5,
    last_error: CODE_REPOSITORY_NOT_CONFIGURED,
  });

  // After the cooldown, re-enqueue re-arms it for a worker that serves the key.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      "UPDATE code_index_jobs SET completed_at = now() - interval '16 minutes' WHERE id = $1",
      [queued.id],
    ),
  );
  await queue.enqueue(context.alice, { repositoryKey: REPOSITORY_KEY, commitOid });
  await expect(
    worker(registry(repositoryPath, [context.alice.workspaceId])).run(queued.id),
  ).resolves.toMatchObject({ status: "complete", jobId: queued.id });
  await expect(
    createCodeIndexModule(context.database).search(context.alice, {
      repositoryKey: REPOSITORY_KEY,
      commitOid,
      query: "rolledMarker",
    }),
  ).resolves.toMatchObject([{ path: "src/rolled.ts" }]);
  expect(logs.map((entry) => [entry.event, entry.errorClass])).toEqual([
    ["job_retry", "CodeRepositoryUnavailableError"],
    ["job_retry", "CodeRepositoryUnavailableError"],
    ["job_dead", "CodeRepositoryUnavailableError"],
    ["job_complete", undefined],
  ]);
  expect(JSON.stringify(logs)).not.toContain(repositoryPath);
});

test("a committer-chosen path with control characters ends dead with an inert detail", async () => {
  const context = await createMemoryTestContext();
  const { repositoryPath, commitOid } = await committedRepository({
    "src/ok.ts": "export const ok = 1;\n",
    "src/tab\there\nnew\u001b[2Jline.ts": "export const hostile = 1;\n",
  });
  const repositories = registry(repositoryPath);
  const queued = await createCodeIndexQueueModule(context.database, repositories).enqueue(
    context.alice,
    { repositoryKey: REPOSITORY_KEY, commitOid },
  );

  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase, { repositories }).run(queued.id),
  ).resolves.toEqual({ status: "dead", jobId: queued.id });
  const job = await createCodeIndexModule(context.database).getIndexJob(context.alice, {
    jobId: queued.id,
  });
  expect(job).toMatchObject({ status: "dead", attemptCount: 1 });
  // Whether Git quotes the path or hands it over raw, no reader of job status receives a
  // tab, line break, or terminal escape.
  expect(job.lastError).toMatch(/^Invalid repository-relative path: /);
  const controls = Array.from(job.lastError ?? "").filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  expect(controls).toEqual([]);
});

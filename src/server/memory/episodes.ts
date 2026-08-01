// Episodic and procedural memory.
//
// An EPISODE is what observably happened on one run: the goal, the actions taken,
// the tools used, the result, and — when the trace supports it — a reusable
// lesson. It records the SOURCE EVENT RANGE rather than copying the trace, because
// the events are already the ground truth and duplicating them would create a
// second thing to keep consistent. No hidden reasoning is stored, only observable
// inputs, outputs and outcomes.
//
// A PROCEDURE is a generalization over episodes, and it is deliberately hard to
// create: one success is an anecdote. Two supporting episodes, or one plus an
// explicit human approval. Crucially a procedure NEVER grants permission — it may
// name a tool, but whether that tool can be used is decided by current
// authorization, every time.

import type { Db } from "../db";
import type { MemoryItem } from "./items";
import { getMemory, inRepoActor, memoryFingerprint, rowToMemory, writeMemory } from "./items";
import type { ScopeType } from "./items";

export interface EpisodeInput {
  scopeType: ScopeType;
  scopeId?: string | null;
  goal: string;
  /** Observable steps, in order. Not reasoning. */
  actions: string[];
  tools?: string[];
  initialState?: string;
  result: string;
  success: boolean;
  failureCategory?: string;
  artifacts?: { name: string; reference: string; type: string }[];
  lesson?: string;
  /** The events this episode is a reading of. Required: an episode is evidence. */
  sourceEventIds: string[];
  createdBy?: string;
}

function renderEpisode(e: EpisodeInput): string {
  const lines = [`Goal: ${e.goal}`];
  if (e.initialState) lines.push(`Initial state: ${e.initialState}`);
  if (e.actions.length)
    lines.push(`Actions: ${e.actions.map((a, i) => `${i + 1}. ${a}`).join(" ")}`);
  if (e.tools?.length) lines.push(`Tools: ${e.tools.join(", ")}`);
  lines.push(`Result: ${e.result}`, `Outcome: ${e.success ? "success" : "failure"}`);
  if (!e.success && e.failureCategory) lines.push(`Failure category: ${e.failureCategory}`);
  if (e.lesson) lines.push(`Lesson: ${e.lesson}`);
  return lines.join("\n");
}

// Recording the same run twice is a NOOP: the fingerprint covers the source event
// range, so re-extraction over the same events cannot produce a second episode.
export async function recordEpisode(
  db: Db,
  input: EpisodeInput,
): Promise<{ memory: MemoryItem | null; operation: string; reason?: string }> {
  const res = await writeMemory(db, {
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    memoryType: "episodic",
    // Episodes are events, not values: no logical key, so they accumulate
    // instead of superseding one another.
    memoryKey: null,
    content: renderEpisode(input),
    structuredValue: {
      goal: input.goal,
      initial_state: input.initialState ?? null,
      actions: input.actions,
      tools: input.tools ?? [],
      result: input.result,
      success: input.success,
      failure_category: input.failureCategory ?? null,
      artifacts: input.artifacts ?? [],
      lesson: input.lesson ?? null,
      source_event_ids: input.sourceEventIds,
    },
    sourceEventIds: input.sourceEventIds,
    // Observed execution is as explicit as evidence gets: it is what happened,
    // not what someone inferred.
    explicit: true,
    confidence: 0.8,
    salience: input.success ? 0.5 : 0.7, // failures are more worth remembering
    createdBy: input.createdBy ?? inRepoActor("episode-recorder"),
  });
  return { memory: res.memory, operation: res.operation, reason: res.reason };
}

export interface ProcedureInput {
  scopeType: ScopeType;
  scopeId?: string | null;
  goalPattern: string;
  preconditions: string[];
  requiredTools: string[];
  requiredPermissions: string[];
  steps: string[];
  verification: string[];
  knownFailureModes: string[];
  applicability: string;
  supportingEpisodeIds: string[];
  /** A human said yes. Lets a single episode promote. */
  approved?: boolean;
  createdBy?: string;
}

export const MIN_EPISODES_TO_PROMOTE = 2;

function renderProcedure(p: ProcedureInput, successes: number, failures: number): string {
  const list = (label: string, items: string[]) =>
    items.length ? `${label}: ${items.map((s, i) => `${i + 1}. ${s}`).join(" ")}` : null;
  return [
    `Goal pattern: ${p.goalPattern}`,
    list("Preconditions", p.preconditions),
    p.requiredTools.length ? `Required tools: ${p.requiredTools.join(", ")}` : null,
    // Recorded so a reader knows what this needs — NOT a grant. Authorization is
    // checked at call time by the tool layer, which never consults memory.
    p.requiredPermissions.length
      ? `Required permissions (informational only): ${p.requiredPermissions.join(", ")}`
      : null,
    list("Steps", p.steps),
    list("Verification", p.verification),
    list("Known failure modes", p.knownFailureModes),
    `Applicability: ${p.applicability}`,
    `Evidence: ${successes} successful and ${failures} failed episodes`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PromoteResult {
  memory: MemoryItem | null;
  operation: string;
  reason?: string;
}

// Promotion is gated on evidence, and the gate is checked against the actual
// episode rows rather than the caller's say-so.
export async function promoteProcedure(db: Db, input: ProcedureInput): Promise<PromoteResult> {
  const episodes: MemoryItem[] = [];
  for (const id of input.supportingEpisodeIds) {
    const m = await getMemory(db, id);
    if (m && m.memory_type === "episodic") episodes.push(m);
  }
  const successes = episodes.filter((e) => e.structured_value?.success === true).length;
  const failures = episodes.length - successes;
  if (successes < MIN_EPISODES_TO_PROMOTE && !(successes >= 1 && input.approved)) {
    return {
      memory: null,
      operation: "REJECT",
      reason: `needs ${MIN_EPISODES_TO_PROMOTE} successful episodes, or 1 plus explicit approval (have ${successes}${input.approved ? ", approved" : ""})`,
    };
  }

  // Provenance flows through from the episodes: a procedure cites the same events
  // its evidence did.
  const sourceEventIds = [
    ...new Set(
      episodes.flatMap((e) =>
        Array.isArray(e.structured_value?.source_event_ids)
          ? (e.structured_value.source_event_ids as string[])
          : [],
      ),
    ),
  ];

  const res = await writeMemory(db, {
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    memoryType: "procedural",
    // Keyed on the goal pattern: an updated procedure SUPERSEDES rather than
    // destructively overwriting, so the old version stays readable.
    memoryKey: `procedure.${input.goalPattern.toLowerCase().replace(/\s+/g, "_").slice(0, 80)}`,
    content: renderProcedure(input, successes, failures),
    structuredValue: {
      goal_pattern: input.goalPattern,
      preconditions: input.preconditions,
      required_tools: input.requiredTools,
      required_permissions: input.requiredPermissions,
      steps: input.steps,
      verification: input.verification,
      known_failure_modes: input.knownFailureModes,
      applicability: input.applicability,
      supporting_episodes: episodes.map((e) => e.id),
      success_count: successes,
      failure_count: failures,
      approved: Boolean(input.approved),
    },
    sourceEventIds,
    explicit: true,
    confidence: Math.min(0.5 + 0.15 * successes, 0.9),
    salience: 0.7,
    createdBy: input.createdBy ?? inRepoActor("procedure-promoter"),
  });
  if (res.memory) {
    for (const e of episodes) {
      await db.query(
        "INSERT INTO procedure_episodes (procedure_id, episode_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [res.memory.id, e.id],
      );
    }
  }
  return { memory: res.memory, operation: res.operation, reason: res.reason };
}

// Episodes that share a goal and have succeeded at least twice are procedure
// candidates. Consolidation calls this; it proposes, it does not auto-commit.
export async function findProcedureCandidates(
  db: Db,
  args: { scopeType: ScopeType; scopeId?: string | null; limit?: number },
): Promise<{ goal: string; episodeIds: string[]; successes: number }[]> {
  const res = await db.query(
    `SELECT structured_value->>'goal' AS goal,
            array_agg(id ORDER BY created_at) AS ids,
            count(*) FILTER (WHERE (structured_value->>'success')::boolean) AS successes
     FROM memory_items
     WHERE memory_type = 'episodic' AND status = 'committed'
       AND scope_type = $1 AND coalesce(scope_id, '') = coalesce($2, '')
       AND structured_value->>'goal' IS NOT NULL
     GROUP BY 1
     HAVING count(*) FILTER (WHERE (structured_value->>'success')::boolean) >= $3
     LIMIT $4`,
    [
      args.scopeType,
      args.scopeId ?? null,
      MIN_EPISODES_TO_PROMOTE,
      Math.min(Math.max(args.limit ?? 20, 1), 100),
    ],
  );
  return res.rows.map((r) => ({
    goal: String(r.goal),
    episodeIds: (r.ids as string[]).map(String),
    successes: Number(r.successes),
  }));
}

// Exposed for tests and for the eval harness: the fingerprint an episode over a
// given event range WOULD get, so idempotence can be asserted directly.
export function episodeFingerprint(input: EpisodeInput): Promise<string> {
  return memoryFingerprint({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    memoryType: "episodic",
    memoryKey: null,
    content: renderEpisode(input),
    sourceEventIds: input.sourceEventIds,
  });
}

export { rowToMemory };

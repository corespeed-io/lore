import {
  isPostgresAccessDenied,
  type PostgresDatabase,
  type PostgresTransaction,
} from "@corespeed/lore-core";
import type { ObservationKind } from "@corespeed/lore-core/episodes";
import { type ActorContext, installActorContext } from "@/server/auth/actor-context";
import { DomainError } from "@/server/errors";

/**
 * Memory Observation Evidence: a canonical Memory's citation of an immutable
 * Observation it came from. A row holds ids only. It is visible while both the
 * Memory and the Observation's Episode are visible, citing needs write authority
 * over the Memory, and forgetting either side deletes it (migration 0014).
 */
export const MEMORY_OBSERVATION_EVIDENCE_LIMITS = Object.freeze({
  /** Observations one Memory may cite, counting only citations the Actor can see. */
  maximumObservationsPerMemory: 50,
  /** Memories one read may name. */
  maximumReadMemories: 20,
  /** Characters (code points) one read returns when no budget is given. */
  defaultReadCharacters: 24_000,
  /** The largest budget one read accepts: one whole Observation. */
  maximumReadCharacters: 100_000,
});

export interface MemoryObservationEvidence {
  memoryId: string;
  observationId: string;
  episodeId: string;
  observationOrdinal: number;
  observationKind: ObservationKind;
  observedAt: string;
  createdByUserId: string;
  createdByAgentId: string | null;
  createdAt: string;
}

export interface MemoryObservationEvidenceKey {
  memoryId: string;
  observationId: string;
}

export interface CitedMemoryObservationEvidence {
  evidence: MemoryObservationEvidence;
  created: boolean;
}

export interface ReadMemoryObservationEvidenceInput {
  /** Memories in the order their sources should be read, such as search rank. */
  memoryIds: readonly string[];
  maximumCharacters?: number;
}

/** One cited Observation, once, with every given Memory that cites it. */
export interface MemorySourceObservation {
  observationId: string;
  episodeId: string;
  observationOrdinal: number;
  observationKind: ObservationKind;
  observedAt: string;
  memoryIds: string[];
  content: string;
  contentTruncated: boolean;
}

export interface MemorySourceRead {
  sources: MemorySourceObservation[];
  /** Cited Observations the budget left out, in reading order. */
  omittedObservationIds: string[];
}

export class MemoryObservationEvidenceValidationError extends DomainError {
  override name = "MemoryObservationEvidenceValidationError";
  readonly code = "invalid_request";
}

export class MemoryObservationEvidenceCapacityError extends DomainError {
  override name = "MemoryObservationEvidenceCapacityError";
  readonly code = "memory_observation_evidence_capacity_exceeded";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new MemoryObservationEvidenceValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function validKey(input: MemoryObservationEvidenceKey): MemoryObservationEvidenceKey {
  return {
    memoryId: uuid(input.memoryId, "memoryId"),
    observationId: uuid(input.observationId, "observationId"),
  };
}

/** RFC 3339 UTC with microseconds, as every other Lore timestamp is served. */
function utcTimestamp(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

interface EvidenceRow {
  memory_id: string;
  observation_id: string;
  episode_id: string;
  observation_ordinal: number;
  observation_kind: ObservationKind;
  observed_at: string;
  created_by_user_id: string;
  created_by_agent_id: string | null;
  created_at: string;
}

const EVIDENCE_SELECT = `SELECT evidence.memory_id, evidence.observation_id,
    observation.episode_id, observation.ordinal AS observation_ordinal,
    observation.kind AS observation_kind,
    ${utcTimestamp("observation.observed_at")} AS observed_at,
    evidence.created_by_user_id, evidence.created_by_agent_id,
    ${utcTimestamp("evidence.created_at")} AS created_at
  FROM memory_observation_evidence evidence
  JOIN observations observation
    ON observation.workspace_id = evidence.workspace_id
   AND observation.id = evidence.observation_id`;

/** Chronological, so a Memory's sources read in the order they were observed. */
const OBSERVATION_ORDER = "observation.observed_at, observation.episode_id, observation.ordinal";

function toEvidence(row: EvidenceRow): MemoryObservationEvidence {
  return {
    memoryId: row.memory_id,
    observationId: row.observation_id,
    episodeId: row.episode_id,
    observationOrdinal: row.observation_ordinal,
    observationKind: row.observation_kind,
    observedAt: row.observed_at,
    createdByUserId: row.created_by_user_id,
    createdByAgentId: row.created_by_agent_id,
    createdAt: row.created_at,
  };
}

/**
 * A write that loses a race with its Observation or Memory: it became invisible
 * (the RLS check refuses the row) or was forgotten (the foreign key is gone) after
 * the checks saw it. Either reads exactly like one that was never visible.
 */
function isVanishedEndpoint(error: unknown): boolean {
  return (
    isPostgresAccessDenied(error) ||
    (error instanceof Error && "code" in error && error.code === "23503")
  );
}

/**
 * Copies a Memory Proposal's surviving Observation evidence onto the Memory it
 * created or updated, in the acceptance transaction. Citations the Memory already
 * holds stay; the result must fit the per-Memory bound, or acceptance fails.
 */
export async function citeProposalObservationEvidence(
  transaction: PostgresTransaction,
  input: { workspaceId: string; proposalId: string; memoryId: string; userId: string },
): Promise<void> {
  const total = await transaction.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM (
       SELECT observation_id FROM memory_observation_evidence
       WHERE workspace_id = $1 AND memory_id = $3
       UNION
       SELECT observation_id FROM memory_proposal_observation_evidence
       WHERE workspace_id = $1 AND proposal_id = $2 AND observation_id IS NOT NULL
     ) cited`,
    [input.workspaceId, input.proposalId, input.memoryId],
  );
  const { maximumObservationsPerMemory } = MEMORY_OBSERVATION_EVIDENCE_LIMITS;
  if ((total.rows[0]?.total ?? 0) > maximumObservationsPerMemory) {
    throw new MemoryObservationEvidenceCapacityError(
      `A Memory may cite at most ${maximumObservationsPerMemory} Observations; remove citations from the target Memory before accepting`,
    );
  }
  await transaction.query(
    `INSERT INTO memory_observation_evidence (
       workspace_id, memory_id, observation_id, created_by_user_id, created_by_agent_id
     )
     SELECT evidence.workspace_id, $3, evidence.observation_id, $4, NULL
     FROM memory_proposal_observation_evidence evidence
     WHERE evidence.workspace_id = $1 AND evidence.proposal_id = $2
       AND evidence.observation_id IS NOT NULL
     ON CONFLICT (memory_id, observation_id) DO NOTHING`,
    [input.workspaceId, input.proposalId, input.memoryId, input.userId],
  );
}

export function createMemoryObservationEvidenceModule(database: PostgresDatabase) {
  return {
    /** The Memory's visible citations, oldest observed first; null when the Memory is not visible. */
    async list(
      actor: ActorContext,
      input: { memoryId: string },
    ): Promise<MemoryObservationEvidence[] | null> {
      const memoryId = uuid(input.memoryId, "memoryId");
      return database.transaction(async (transaction) => {
        installActorContext(transaction, actor);
        await transaction.query("SET TRANSACTION READ ONLY");
        const memory = await transaction.query(
          "SELECT 1 FROM memories WHERE workspace_id = $1 AND id = $2",
          [actor.workspaceId, memoryId],
        );
        if (!memory.rows[0]) return null;
        const rows = await transaction.query<EvidenceRow>(
          `${EVIDENCE_SELECT}
           WHERE evidence.workspace_id = $1 AND evidence.memory_id = $2
           ORDER BY ${OBSERVATION_ORDER}`,
          [actor.workspaceId, memoryId],
        );
        return rows.rows.map(toEvidence);
      });
    },

    /**
     * Cites one Observation from one Memory; repeating it is safe. Null when the
     * Memory is not writable or the Observation is not visible to this Actor.
     */
    async cite(
      actor: ActorContext,
      input: MemoryObservationEvidenceKey,
    ): Promise<CitedMemoryObservationEvidence | null> {
      const { memoryId, observationId } = validKey(input);
      try {
        return await database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
          // FOR NO KEY UPDATE applies the memories UPDATE policy, so only a writable
          // Memory is locked, and concurrent cites of it count one at a time.
          const memory = await transaction.query(
            "SELECT 1 FROM memories WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE",
            [actor.workspaceId, memoryId],
          );
          if (!memory.rows[0]) return null;
          const observation = await transaction.query(
            "SELECT 1 FROM observations WHERE workspace_id = $1 AND id = $2",
            [actor.workspaceId, observationId],
          );
          if (!observation.rows[0]) return null;
          const existing = await transaction.query<EvidenceRow>(
            `${EVIDENCE_SELECT}
             WHERE evidence.workspace_id = $1 AND evidence.memory_id = $2
               AND evidence.observation_id = $3`,
            [actor.workspaceId, memoryId, observationId],
          );
          if (existing.rows[0]) return { evidence: toEvidence(existing.rows[0]), created: false };
          const { maximumObservationsPerMemory } = MEMORY_OBSERVATION_EVIDENCE_LIMITS;
          const cited = await transaction.query<{ cited: number }>(
            `SELECT count(*)::int AS cited FROM (
               SELECT 1 FROM memory_observation_evidence
               WHERE workspace_id = $1 AND memory_id = $2
               LIMIT $3
             ) visible`,
            [actor.workspaceId, memoryId, maximumObservationsPerMemory],
          );
          if ((cited.rows[0]?.cited ?? 0) >= maximumObservationsPerMemory) {
            throw new MemoryObservationEvidenceCapacityError(
              `A Memory may cite at most ${maximumObservationsPerMemory} Observations`,
            );
          }
          await transaction.query(
            `INSERT INTO memory_observation_evidence (
               workspace_id, memory_id, observation_id, created_by_user_id, created_by_agent_id
             ) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (memory_id, observation_id) DO NOTHING`,
            [actor.workspaceId, memoryId, observationId, actor.userId, actor.agentId ?? null],
          );
          const created = await transaction.query<EvidenceRow>(
            `${EVIDENCE_SELECT}
             WHERE evidence.workspace_id = $1 AND evidence.memory_id = $2
               AND evidence.observation_id = $3`,
            [actor.workspaceId, memoryId, observationId],
          );
          const row = created.rows[0];
          return row ? { evidence: toEvidence(row), created: true } : null;
        });
      } catch (error) {
        if (isVanishedEndpoint(error)) return null;
        throw error;
      }
    },

    /** False when this Actor has no such citation to remove through a Memory it may write. */
    async remove(actor: ActorContext, input: MemoryObservationEvidenceKey): Promise<boolean> {
      const { memoryId, observationId } = validKey(input);
      return database.transaction(async (transaction) => {
        installActorContext(transaction, actor);
        const deleted = await transaction.query(
          `DELETE FROM memory_observation_evidence
           WHERE workspace_id = $1 AND memory_id = $2 AND observation_id = $3
           RETURNING 1`,
          [actor.workspaceId, memoryId, observationId],
        );
        return deleted.rows.length > 0;
      });
    },

    /**
     * Reads the Observations the given Memories cite, for an answer the Memories
     * alone could not give. Memories are read in the given order and each one's
     * sources oldest first; an Observation cited twice is returned once. Whole
     * Observations fill the budget; the first one past it is cut to fit, and the
     * rest are listed as omitted. Invisible Memories and Observations contribute
     * nothing.
     */
    async read(
      actor: ActorContext,
      input: ReadMemoryObservationEvidenceInput,
    ): Promise<MemorySourceRead> {
      const limits = MEMORY_OBSERVATION_EVIDENCE_LIMITS;
      if (!Array.isArray(input.memoryIds)) {
        throw new MemoryObservationEvidenceValidationError("memoryIds must be an array");
      }
      const memoryIds = [
        ...new Set(input.memoryIds.map((memoryId) => uuid(memoryId, "memoryIds"))),
      ];
      if (memoryIds.length < 1 || memoryIds.length > limits.maximumReadMemories) {
        throw new MemoryObservationEvidenceValidationError(
          `memoryIds must name 1 to ${limits.maximumReadMemories} distinct Memories`,
        );
      }
      const budget = input.maximumCharacters ?? limits.defaultReadCharacters;
      if (!Number.isInteger(budget) || budget < 1 || budget > limits.maximumReadCharacters) {
        throw new MemoryObservationEvidenceValidationError(
          `maximumCharacters must be an integer from 1 through ${limits.maximumReadCharacters}`,
        );
      }
      return database.transaction(async (transaction) => {
        installActorContext(transaction, actor);
        await transaction.query("SET TRANSACTION READ ONLY");
        // Lengths first, so no more Observation text is read than the budget takes.
        const cited = await transaction.query<
          Omit<EvidenceRow, "created_by_user_id" | "created_by_agent_id" | "created_at"> & {
            characters: number;
          }
        >(
          `SELECT evidence.memory_id, evidence.observation_id,
             observation.episode_id, observation.ordinal AS observation_ordinal,
             observation.kind AS observation_kind,
             ${utcTimestamp("observation.observed_at")} AS observed_at,
             char_length(observation.content) AS characters
           FROM memory_observation_evidence evidence
           JOIN observations observation
             ON observation.workspace_id = evidence.workspace_id
            AND observation.id = evidence.observation_id
           WHERE evidence.workspace_id = $1 AND evidence.memory_id = ANY($2::uuid[])
           ORDER BY array_position($2::uuid[], evidence.memory_id), ${OBSERVATION_ORDER}`,
          [actor.workspaceId, memoryIds],
        );
        const ordered = new Map<string, MemorySourceObservation & { characters: number }>();
        for (const row of cited.rows) {
          const seen = ordered.get(row.observation_id);
          if (seen) {
            if (!seen.memoryIds.includes(row.memory_id)) seen.memoryIds.push(row.memory_id);
            continue;
          }
          ordered.set(row.observation_id, {
            observationId: row.observation_id,
            episodeId: row.episode_id,
            observationOrdinal: row.observation_ordinal,
            observationKind: row.observation_kind,
            observedAt: row.observed_at,
            memoryIds: [row.memory_id],
            content: "",
            contentTruncated: false,
            characters: row.characters,
          });
        }
        const take = new Map<string, number>();
        const omittedObservationIds: string[] = [];
        let remaining = budget;
        for (const source of ordered.values()) {
          if (remaining <= 0) {
            omittedObservationIds.push(source.observationId);
            continue;
          }
          const characters = Math.min(source.characters, remaining);
          take.set(source.observationId, characters);
          remaining -= characters;
        }
        if (!take.size) return { sources: [], omittedObservationIds };
        const ids = [...take.keys()];
        const texts = await transaction.query<{ id: string; content: string }>(
          `SELECT observation.id, substr(observation.content, 1, taken.characters) AS content
           FROM unnest($2::uuid[], $3::int[]) AS taken(id, characters)
           JOIN observations observation
             ON observation.workspace_id = $1 AND observation.id = taken.id`,
          [actor.workspaceId, ids, ids.map((id) => take.get(id) ?? 0)],
        );
        const content = new Map(texts.rows.map((row) => [row.id, row.content]));
        const sources: MemorySourceObservation[] = [];
        for (const id of ids) {
          const source = ordered.get(id);
          const text = content.get(id);
          // Forgotten between the two reads: it is gone, not omitted.
          if (!source || text === undefined) continue;
          const { characters, ...observation } = source;
          sources.push({
            ...observation,
            content: text,
            contentTruncated: (take.get(id) ?? 0) < characters,
          });
        }
        return { sources, omittedObservationIds };
      });
    },
  };
}

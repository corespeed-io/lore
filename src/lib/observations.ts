import { sql } from "drizzle-orm";
import { type ActorContext, installActorContext } from "./actor-context";
import { isPostgresAccessDenied } from "./database-errors";
import type { LoreDatabase, LoreTransaction } from "./db";
import { beginMutation, completeMutation, type IdempotencyRequest } from "./idempotency";
import type { MemoryScope } from "./memory";

export const MAX_EPISODE_OBSERVATIONS = 100;
export const MAX_EPISODE_CONTENT_CHARACTERS = 1_000_000;
export const MAX_EPISODE_METADATA_CHARACTERS = 1_000_000;
export const MAX_OBSERVATION_CONTENT_CHARACTERS = 100_000;
export const MAX_OBSERVATION_BATCH_READ = 50;

export type EpisodeKind = "conversation" | "workflow" | "document" | "event";
export type ObservationKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "document_fragment"
  | "event";

export class ObservationAccessDeniedError extends Error {
  override name = "ObservationAccessDeniedError";
  readonly status = 403;
}

export interface Observation {
  id: string;
  workspaceId: string;
  episodeId: string;
  ordinal: number;
  kind: ObservationKind;
  observedAt: string;
  payloadSha256: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EpisodeSummary {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  recordedByActorKind: "human" | "agent";
  recordedByAgentId: string | null;
  kind: EpisodeKind;
  scope: MemoryScope;
  startedAt: string;
  endedAt: string;
  observationCount: number;
  createdAt: string;
}

export interface Episode extends EpisodeSummary {
  observations: Observation[];
}

export interface RecordObservation {
  kind: ObservationKind;
  content: string;
  metadata?: Record<string, unknown>;
  observedAt?: string;
}

export interface RecordEpisode {
  kind: EpisodeKind;
  scope?: MemoryScope;
  observations: readonly RecordObservation[];
}

export interface ListEpisodes {
  cursor?: { createdAt: string; id: string };
  kind?: EpisodeKind;
  limit?: number;
  scope?: MemoryScope;
}

export interface ObservationMutationOptions {
  idempotency?: IdempotencyRequest;
}

interface EpisodeRow {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  recorded_by_actor_kind: "human" | "agent";
  recorded_by_agent_id: string | null;
  kind: EpisodeKind;
  scope: MemoryScope;
  started_at: string;
  ended_at: string;
  observation_count: number | string;
  created_at: string;
}

interface ObservationRow {
  id: string;
  workspace_id: string;
  episode_id: string;
  ordinal: number;
  kind: ObservationKind;
  observed_at: string;
  payload_sha256: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

const episodeColumns = sql.raw(`
  episode.id,
  episode.workspace_id,
  episode.owner_user_id,
  episode.recorded_by_actor_kind,
  episode.recorded_by_agent_id,
  episode.kind,
  episode.scope,
  to_char(
    episode.started_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS started_at,
  to_char(
    episode.ended_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS ended_at,
  count(observation.id)::integer AS observation_count,
  to_char(
    episode.created_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS created_at
`);

const episodeGroup = sql.raw(`
  episode.id,
  episode.workspace_id,
  episode.owner_user_id,
  episode.recorded_by_actor_kind,
  episode.recorded_by_agent_id,
  episode.kind,
  episode.scope,
  episode.started_at,
  episode.ended_at,
  episode.created_at
`);

function toEpisodeSummary(row: EpisodeRow): EpisodeSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    recordedByActorKind: row.recorded_by_actor_kind,
    recordedByAgentId: row.recorded_by_agent_id,
    kind: row.kind,
    scope: row.scope,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    observationCount: Number(row.observation_count),
    createdAt: row.created_at,
  };
}

function toObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    episodeId: row.episode_id,
    ordinal: row.ordinal,
    kind: row.kind,
    observedAt: row.observed_at,
    payloadSha256: row.payload_sha256,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function normalizedTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("observedAt must be an ISO timestamp");
  return new Date(milliseconds).toISOString();
}

function normalizedEpisode(input: RecordEpisode): {
  endedAt: string;
  observations: Array<{
    content: string;
    kind: ObservationKind;
    metadata: Record<string, unknown>;
    observedAt: string;
  }>;
  startedAt: string;
} {
  if (
    !Array.isArray(input.observations) ||
    input.observations.length < 1 ||
    input.observations.length > MAX_EPISODE_OBSERVATIONS
  ) {
    throw new TypeError(`An Episode must contain 1 to ${MAX_EPISODE_OBSERVATIONS} Observations`);
  }
  const recordedAt = new Date().toISOString();
  let totalCharacters = 0;
  let totalMetadataCharacters = 0;
  const observations = input.observations.map((observation) => {
    if (
      typeof observation.content !== "string" ||
      !observation.content.trim() ||
      observation.content.length > MAX_OBSERVATION_CONTENT_CHARACTERS
    ) {
      throw new TypeError(
        `Observation content must contain 1 to ${MAX_OBSERVATION_CONTENT_CHARACTERS} characters`,
      );
    }
    totalCharacters += observation.content.length;
    totalMetadataCharacters += JSON.stringify(observation.metadata ?? {}).length;
    return {
      kind: observation.kind,
      content: observation.content,
      metadata: observation.metadata ?? {},
      observedAt: normalizedTimestamp(observation.observedAt, recordedAt),
    };
  });
  if (totalCharacters > MAX_EPISODE_CONTENT_CHARACTERS) {
    throw new TypeError(
      `Episode content may contain at most ${MAX_EPISODE_CONTENT_CHARACTERS} characters`,
    );
  }
  if (totalMetadataCharacters > MAX_EPISODE_METADATA_CHARACTERS) {
    throw new TypeError(
      `Episode metadata may contain at most ${MAX_EPISODE_METADATA_CHARACTERS} characters`,
    );
  }
  const timestamps = observations.map((observation) => Date.parse(observation.observedAt));
  return {
    observations,
    startedAt: new Date(Math.min(...timestamps)).toISOString(),
    endedAt: new Date(Math.max(...timestamps)).toISOString(),
  };
}

async function episodeFromId(
  transaction: LoreTransaction,
  workspaceId: string,
  id: string,
): Promise<Episode | null> {
  const episodeResult = await transaction.execute<EpisodeRow>(
    sql`SELECT ${episodeColumns}
     FROM episodes episode
     LEFT JOIN observations observation
       ON observation.workspace_id = episode.workspace_id
      AND observation.episode_id = episode.id
     WHERE episode.workspace_id = ${workspaceId} AND episode.id = ${id}
     GROUP BY ${episodeGroup}`,
  );
  const episode = episodeResult.rows[0];
  if (!episode) return null;
  const observationResult = await transaction.execute<ObservationRow>(
    sql`SELECT
       observation.id,
       observation.workspace_id,
       observation.episode_id,
       observation.ordinal,
       observation.kind,
       to_char(
         observation.observed_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS observed_at,
       observation.payload_sha256,
       observation.content,
       observation.metadata,
       to_char(
         observation.created_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS created_at
     FROM observations observation
     WHERE observation.workspace_id = ${workspaceId} AND observation.episode_id = ${id}
     ORDER BY observation.ordinal`,
  );
  return {
    ...toEpisodeSummary(episode),
    observations: observationResult.rows.map(toObservation),
  };
}

export function createObservationModule(database: LoreDatabase) {
  return {
    async record(
      actor: ActorContext,
      input: RecordEpisode,
      options: ObservationMutationOptions = {},
    ): Promise<Episode> {
      const normalized = normalizedEpisode(input);
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const claim = await beginMutation<{ episode: Episode }>(
            transaction,
            actor,
            options.idempotency,
          );
          if (claim.replay) return claim.replay.body.episode;
          const result = await transaction.execute<{ id: string }>(
            sql`SELECT lore.record_episode(
               ${actor.workspaceId},
               ${actor.userId},
               ${actor.agentId ? "agent" : "human"},
               ${actor.agentId ?? null},
               ${input.kind},
               ${input.scope ?? "private"},
               ${normalized.startedAt},
               ${normalized.endedAt},
               ${JSON.stringify(normalized.observations)}::json
             ) AS id`,
          );
          const episode = await episodeFromId(transaction, actor.workspaceId, result.rows[0].id);
          if (!episode) throw new Error("Recorded Episode was not readable in its transaction");
          await completeMutation(
            transaction,
            claim.requestId,
            201,
            { episode },
            Boolean(options.idempotency),
          );
          return episode;
        });
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new ObservationAccessDeniedError("Actor cannot record this Episode", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async retrieve(actor: ActorContext, id: string): Promise<Episode | null> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        return episodeFromId(transaction, actor.workspaceId, id);
      });
    },

    async retrieveObservations(
      actor: ActorContext,
      ids: readonly string[],
    ): Promise<Observation[]> {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length > MAX_OBSERVATION_BATCH_READ) {
        throw new TypeError(
          `At most ${MAX_OBSERVATION_BATCH_READ} Observations may be read at once`,
        );
      }
      if (uniqueIds.length === 0) return [];
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.execute<ObservationRow>(
          sql`SELECT
             observation.id,
             observation.workspace_id,
             observation.episode_id,
             observation.ordinal,
             observation.kind,
             to_char(
               observation.observed_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS observed_at,
             observation.payload_sha256,
             observation.content,
             observation.metadata,
             to_char(
               observation.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS created_at
           FROM observations observation
           WHERE observation.workspace_id = ${actor.workspaceId}
             AND observation.id = ANY(${sql.param(uniqueIds)}::uuid[])
           ORDER BY array_position(${sql.param(uniqueIds)}::uuid[], observation.id)`,
        );
        return result.rows.map(toObservation);
      });
    },

    async list(actor: ActorContext, input: ListEpisodes = {}): Promise<EpisodeSummary[]> {
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.execute<EpisodeRow>(
          sql`SELECT ${episodeColumns}
           FROM episodes episode
           LEFT JOIN observations observation
             ON observation.workspace_id = episode.workspace_id
            AND observation.episode_id = episode.id
           WHERE episode.workspace_id = ${actor.workspaceId}
             AND (${input.kind ?? null}::episode_kind IS NULL OR episode.kind = ${input.kind ?? null}::episode_kind)
             AND (${input.scope ?? null}::memory_scope IS NULL OR episode.scope = ${input.scope ?? null}::memory_scope)
             AND (
               ${input.cursor?.createdAt ?? null}::timestamptz IS NULL
               OR episode.created_at < ${input.cursor?.createdAt ?? null}::timestamptz
               OR (
                 episode.created_at = ${input.cursor?.createdAt ?? null}::timestamptz
                 AND episode.id > ${input.cursor?.id ?? null}::uuid
               )
             )
           GROUP BY ${episodeGroup}
           ORDER BY episode.created_at DESC, episode.id
           LIMIT ${limit}`,
        );
        return result.rows.map(toEpisodeSummary);
      });
    },

    async forget(
      actor: ActorContext,
      id: string,
      options: ObservationMutationOptions = {},
    ): Promise<boolean> {
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const claim = await beginMutation<{ deleted: boolean }>(
            transaction,
            actor,
            options.idempotency,
          );
          if (claim.replay) return claim.replay.body.deleted;
          const result = await transaction.execute<{ id: string }>(
            sql`DELETE FROM episodes
             WHERE workspace_id = ${actor.workspaceId}
               AND id = ${id}
               AND lore.can_write_memory(workspace_id, owner_user_id)
             RETURNING id`,
          );
          const deleted = result.rows.length === 1;
          await completeMutation(
            transaction,
            claim.requestId,
            deleted ? 204 : 404,
            { deleted },
            Boolean(options.idempotency),
          );
          return deleted;
        });
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new ObservationAccessDeniedError("Actor cannot forget this Episode", {
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}

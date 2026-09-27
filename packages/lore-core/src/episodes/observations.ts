import type { MemoryStorageContext, PostgresTransaction } from "../db";
import type { MemoryScope } from "../memory";
import { MEMORY_LIST_LIMITS, validateMemoryMetadata, validateMemoryScope } from "../memory-input";
import { utcTimestampSql } from "../timestamp";
import { boundedInteger, isStorableText, LoreValidationError } from "../validation";

export const MAX_EPISODE_OBSERVATIONS = 100;
export const MAX_EPISODE_CONTENT_CHARACTERS = 1_000_000;
export const MAX_EPISODE_METADATA_CHARACTERS = 1_000_000;
export const MAX_OBSERVATION_CONTENT_CHARACTERS = 100_000;
export const MAX_OBSERVATION_BATCH_READ = 50;

export const EPISODE_KINDS = ["conversation", "workflow", "document", "event"] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];
export const OBSERVATION_KINDS = [
  "message",
  "tool_call",
  "tool_result",
  "document_fragment",
  "event",
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export function validateEpisodeKind(value: unknown, field = "kind"): EpisodeKind {
  if (!EPISODE_KINDS.includes(value as EpisodeKind)) {
    throw new LoreValidationError(field, `${field} must be ${listOf(EPISODE_KINDS)}`);
  }
  return value as EpisodeKind;
}

export function validateObservationKind(value: unknown, field = "kind"): ObservationKind {
  if (!OBSERVATION_KINDS.includes(value as ObservationKind)) {
    throw new LoreValidationError(field, `${field} must be ${listOf(OBSERVATION_KINDS)}`);
  }
  return value as ObservationKind;
}

/** An Episode holds 1 to MAX_EPISODE_OBSERVATIONS Observations. */
export function validateObservationCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_EPISODE_OBSERVATIONS) {
    throw new LoreValidationError(
      "observations",
      `observations must contain 1 to ${MAX_EPISODE_OBSERVATIONS} items`,
    );
  }
}

function listOf(values: readonly string[]): string {
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

export interface Observation {
  id: string;
  partitionId: string;
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
  partitionId: string;
  ownerId: string;
  recordedByActorKind: "human" | "agent";
  sourceId: string | null;
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

// Selected with GROUP BY episode.id: the primary key makes every other episode
// column functionally dependent, so hosts must keep episodes.id as the key.
const episodeColumns = `
  episode.id,
  episode.workspace_id,
  episode.owner_user_id,
  episode.recorded_by_actor_kind,
  episode.recorded_by_agent_id,
  episode.kind,
  episode.scope,
  ${utcTimestampSql("episode.started_at")} AS started_at,
  ${utcTimestampSql("episode.ended_at")} AS ended_at,
  count(observation.id)::integer AS observation_count,
  ${utcTimestampSql("episode.created_at")} AS created_at
`;

const observationColumns = `
  observation.id,
  observation.workspace_id,
  observation.episode_id,
  observation.ordinal,
  observation.kind,
  ${utcTimestampSql("observation.observed_at")} AS observed_at,
  observation.payload_sha256,
  observation.content,
  observation.metadata,
  ${utcTimestampSql("observation.created_at")} AS created_at
`;

function toEpisodeSummary(row: EpisodeRow): EpisodeSummary {
  return {
    id: row.id,
    partitionId: row.workspace_id,
    ownerId: row.owner_user_id,
    recordedByActorKind: row.recorded_by_actor_kind,
    sourceId: row.recorded_by_agent_id,
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
    partitionId: row.workspace_id,
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

function normalizedTimestamp(value: string | undefined, fallback: string, field: string): string {
  if (value === undefined) return fallback;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new LoreValidationError(field, `${field} must be an ISO 8601 timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

/**
 * The engine's Episode admission rules: kinds, scope, Observation count and
 * content/metadata bounds, and timestamps. Hosts validate wire shapes only.
 */
export function normalizedEpisode(input: RecordEpisode): {
  endedAt: string;
  observations: Array<{
    content: string;
    kind: ObservationKind;
    metadata: Record<string, unknown>;
    observedAt: string;
  }>;
  startedAt: string;
} {
  validateEpisodeKind(input.kind);
  if (input.scope !== undefined) validateMemoryScope(input.scope);
  if (!Array.isArray(input.observations)) {
    throw new LoreValidationError("observations", "observations must be an array");
  }
  validateObservationCount(input.observations.length);
  const recordedAt = new Date().toISOString();
  let totalCharacters = 0;
  let totalMetadataCharacters = 0;
  const observations = input.observations.map((observation, index) => {
    const field = `observations[${index}]`;
    const kind = validateObservationKind(observation.kind, `${field}.kind`);
    if (
      typeof observation.content !== "string" ||
      !observation.content.trim() ||
      observation.content.length > MAX_OBSERVATION_CONTENT_CHARACTERS
    ) {
      throw new LoreValidationError(
        `${field}.content`,
        `${field}.content must contain 1 to ${MAX_OBSERVATION_CONTENT_CHARACTERS} characters`,
      );
    }
    if (!isStorableText(observation.content)) {
      throw new LoreValidationError(
        `${field}.content`,
        `${field}.content contains a NUL character or invalid Unicode`,
      );
    }
    const metadata =
      observation.metadata === undefined
        ? {}
        : validateMemoryMetadata(observation.metadata, `${field}.metadata`);
    // validateMemoryMetadata already bounds each Observation's metadata.
    const metadataCharacters = JSON.stringify(metadata).length;
    totalCharacters += observation.content.length;
    totalMetadataCharacters += metadataCharacters;
    return {
      kind,
      content: observation.content,
      metadata,
      observedAt: normalizedTimestamp(observation.observedAt, recordedAt, `${field}.observedAt`),
    };
  });
  if (totalCharacters > MAX_EPISODE_CONTENT_CHARACTERS) {
    throw new LoreValidationError(
      "observations",
      `Episode content exceeds ${MAX_EPISODE_CONTENT_CHARACTERS} characters`,
    );
  }
  if (totalMetadataCharacters > MAX_EPISODE_METADATA_CHARACTERS) {
    throw new LoreValidationError(
      "observations",
      `Episode metadata exceeds ${MAX_EPISODE_METADATA_CHARACTERS} characters`,
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
  transaction: PostgresTransaction,
  partitionId: string,
  id: string,
): Promise<Episode | null> {
  const episodeResult = await transaction.query<EpisodeRow>(
    `SELECT ${episodeColumns}
     FROM episodes episode
     LEFT JOIN observations observation
       ON observation.workspace_id = episode.workspace_id
      AND observation.episode_id = episode.id
     WHERE episode.workspace_id = $1 AND episode.id = $2
     GROUP BY episode.id`,
    [partitionId, id],
  );
  const episode = episodeResult.rows[0];
  if (!episode) return null;
  const observationResult = await transaction.query<ObservationRow>(
    `SELECT ${observationColumns}
     FROM observations observation
     WHERE observation.workspace_id = $1 AND observation.episode_id = $2
     ORDER BY observation.ordinal`,
    [partitionId, id],
  );
  return {
    ...toEpisodeSummary(episode),
    observations: observationResult.rows.map(toObservation),
  };
}

/** Read and delete Episode storage through a host-scoped database. */
export function createObservationModule(storage: MemoryStorageContext) {
  const { database } = storage;
  return {
    async retrieve(id: string): Promise<Episode | null> {
      return database.transaction((transaction) =>
        episodeFromId(transaction, storage.partitionId, id),
      );
    },

    async retrieveObservations(ids: readonly string[]): Promise<Observation[]> {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length > MAX_OBSERVATION_BATCH_READ) {
        throw new LoreValidationError(
          "ids",
          `At most ${MAX_OBSERVATION_BATCH_READ} Observations may be read at once`,
        );
      }
      if (uniqueIds.length === 0) return [];
      return database.transaction(async (transaction) => {
        const result = await transaction.query<ObservationRow>(
          `SELECT ${observationColumns}
           FROM observations observation
           WHERE observation.workspace_id = $1
             AND observation.id = ANY($2::uuid[])
           ORDER BY array_position($2::uuid[], observation.id)`,
          [storage.partitionId, uniqueIds],
        );
        return result.rows.map(toObservation);
      });
    },

    async list(input: ListEpisodes = {}): Promise<EpisodeSummary[]> {
      const limit = boundedInteger(input.limit, "limit", {
        minimum: 1,
        maximum: MEMORY_LIST_LIMITS.maximumLimit,
        fallback: MEMORY_LIST_LIMITS.defaultLimit,
      });
      if (input.kind !== undefined) validateEpisodeKind(input.kind);
      if (input.scope !== undefined) validateMemoryScope(input.scope);
      return database.transaction(async (transaction) => {
        const result = await transaction.query<EpisodeRow>(
          `SELECT ${episodeColumns}
           FROM episodes episode
           LEFT JOIN observations observation
             ON observation.workspace_id = episode.workspace_id
            AND observation.episode_id = episode.id
           WHERE episode.workspace_id = $1
             AND ($2::episode_kind IS NULL OR episode.kind = $2::episode_kind)
             AND ($3::memory_scope IS NULL OR episode.scope = $3::memory_scope)
             AND (
               $4::timestamptz IS NULL
               OR episode.created_at < $4::timestamptz
               OR (episode.created_at = $4::timestamptz AND episode.id > $5::uuid)
             )
           GROUP BY episode.id
           ORDER BY episode.created_at DESC, episode.id
           LIMIT $6`,
          [
            storage.partitionId,
            input.kind ?? null,
            input.scope ?? null,
            input.cursor?.createdAt ?? null,
            input.cursor?.id ?? null,
            limit,
          ],
        );
        return result.rows.map(toEpisodeSummary);
      });
    },

    async forget(id: string): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          `DELETE FROM episodes
           WHERE workspace_id = $1
             AND id = $2
           RETURNING id`,
          [storage.partitionId, id],
        );
        return result.rows.length === 1;
      });
    },
  };
}

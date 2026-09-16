import { isPostgresAccessDenied, type PostgresDatabase } from "@corespeed/lore-core";
import {
  createObservationModule as createCoreObservationModule,
  type ListEpisodes,
  normalizedEpisode,
  type RecordEpisode,
  type Episode as StoredEpisode,
  type EpisodeSummary as StoredEpisodeSummary,
  type Observation as StoredObservation,
} from "@corespeed/lore-core/episodes";
import { type ActorContext, installActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage, memoryStorageInTransaction } from "@/server/database/memory-storage";
import {
  beginMutation,
  completeMutation,
  type IdempotencyRequest,
} from "@/server/http/idempotency";

export type {
  EpisodeKind,
  ListEpisodes,
  ObservationKind,
  RecordEpisode,
  RecordObservation,
} from "@corespeed/lore-core/episodes";
export {
  MAX_EPISODE_CONTENT_CHARACTERS,
  MAX_EPISODE_METADATA_CHARACTERS,
  MAX_EPISODE_OBSERVATIONS,
  MAX_OBSERVATION_BATCH_READ,
  MAX_OBSERVATION_CONTENT_CHARACTERS,
} from "@corespeed/lore-core/episodes";
export * from "./evidence";

export class ObservationAccessDeniedError extends Error {
  override name = "ObservationAccessDeniedError";
  readonly status = 403;
}

export interface Observation extends Omit<StoredObservation, "partitionId"> {
  workspaceId: string;
}

export interface EpisodeSummary
  extends Omit<StoredEpisodeSummary, "partitionId" | "ownerId" | "sourceId"> {
  workspaceId: string;
  ownerUserId: string;
  recordedByAgentId: string | null;
}

export interface Episode extends EpisodeSummary {
  observations: Observation[];
}

export interface ObservationMutationOptions {
  idempotency?: IdempotencyRequest;
}

function toObservation({ partitionId, ...observation }: StoredObservation): Observation {
  return { ...observation, workspaceId: partitionId };
}

function toEpisodeSummary({
  partitionId,
  ownerId,
  sourceId,
  ...episode
}: StoredEpisodeSummary): EpisodeSummary {
  return {
    ...episode,
    workspaceId: partitionId,
    ownerUserId: ownerId,
    recordedByAgentId: sourceId,
  };
}

function toEpisode({ observations, ...episode }: StoredEpisode): Episode {
  return { ...toEpisodeSummary(episode), observations: observations.map(toObservation) };
}

/** OSS owns authenticated Episode admission and replay-safe HTTP mutations. */
export function createObservationModule(database: PostgresDatabase) {
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
          // This OSS schema function authorizes User/Agent provenance and owns
          // the immutable Episode insert privileges unavailable to lore_app.
          const result = await transaction.query<{ id: string }>(
            `SELECT lore.record_episode(
               $1, $2, $3, $4, $5, $6, $7, $8, $9::json
             ) AS id`,
            [
              actor.workspaceId,
              actor.userId,
              actor.agentId ? "agent" : "human",
              actor.agentId ?? null,
              input.kind,
              input.scope ?? "private",
              normalized.startedAt,
              normalized.endedAt,
              JSON.stringify(normalized.observations),
            ],
          );
          const recorded = result.rows[0];
          if (!recorded) throw new Error("Episode record returned no row");
          const stored = await createCoreObservationModule(
            memoryStorageInTransaction(transaction, actor),
          ).retrieve(recorded.id);
          if (!stored) throw new Error("Recorded Episode was not readable in its transaction");
          const episode = toEpisode(stored);
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
      const episode = await createCoreObservationModule(
        createMemoryStorage(database, actor),
      ).retrieve(id);
      return episode ? toEpisode(episode) : null;
    },

    async retrieveObservations(
      actor: ActorContext,
      ids: readonly string[],
    ): Promise<Observation[]> {
      const observations = await createCoreObservationModule(
        createMemoryStorage(database, actor),
      ).retrieveObservations(ids);
      return observations.map(toObservation);
    },

    async list(actor: ActorContext, input: ListEpisodes = {}): Promise<EpisodeSummary[]> {
      const episodes = await createCoreObservationModule(createMemoryStorage(database, actor)).list(
        input,
      );
      return episodes.map(toEpisodeSummary);
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
          const writable = await transaction.query<{ id: string }>(
            `SELECT id FROM episodes
             WHERE workspace_id = $1 AND id = $2
               AND lore.can_write_memory(workspace_id, owner_user_id)`,
            [actor.workspaceId, id],
          );
          const deleted =
            writable.rows.length > 0
              ? await createCoreObservationModule(
                  memoryStorageInTransaction(transaction, actor),
                ).forget(id)
              : false;
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

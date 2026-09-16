import type { PostgresDatabase } from "@corespeed/lore-core";
import {
  createEpisodeEvidenceModule as createCoreEpisodeEvidenceModule,
  type EpisodeEvidenceIndexResult,
  type EpisodeEvidenceModuleOptions,
  type EpisodeEvidenceSearchResult,
  type IndexEpisodeEvidence,
  type SearchEpisodeEvidence,
} from "@corespeed/lore-core/episodes";
import type { ActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage } from "@/server/database/memory-storage";

export type {
  EpisodeEvidenceIndexResult,
  EpisodeEvidenceModuleOptions,
  EpisodeEvidenceSearchResult,
  IndexEpisodeEvidence,
  SearchEpisodeEvidence,
} from "@corespeed/lore-core/episodes";
export {
  EPISODE_EVIDENCE_INDEX_REVISION,
  EPISODE_EVIDENCE_RETRIEVAL_POLICY,
} from "@corespeed/lore-core/episodes";

export class EpisodeEvidenceAccessDeniedError extends Error {
  override name = "EpisodeEvidenceAccessDeniedError";
  readonly status = 403;
}

/** Index admission is an OSS write policy, including read-only verification. */
export function createEpisodeEvidenceModule(
  database: PostgresDatabase,
  options: EpisodeEvidenceModuleOptions = {},
) {
  return {
    index(actor: ActorContext, input: IndexEpisodeEvidence): Promise<EpisodeEvidenceIndexResult> {
      const storage = createMemoryStorage(database, actor);
      return createCoreEpisodeEvidenceModule(
        {
          ...storage,
          database: {
            transaction: (use) =>
              storage.database.transaction(async (transaction) => {
                // Indexing spans transactions and model calls. Recheck admission
                // each time, so a revoked grant cannot resume an authorized run.
                const writable = await transaction.query<{ id: string }>(
                  `SELECT id FROM episodes
                   WHERE workspace_id = $1 AND id = $2
                     AND lore.can_write_memory(workspace_id, owner_user_id)`,
                  [actor.workspaceId, input.episodeId],
                );
                if (!writable.rows[0]) {
                  throw new EpisodeEvidenceAccessDeniedError("Actor cannot index this Episode");
                }
                return use(transaction);
              }),
          },
        },
        options,
      ).index(input);
    },

    search(
      actor: ActorContext,
      input: SearchEpisodeEvidence,
    ): Promise<EpisodeEvidenceSearchResult[]> {
      return createCoreEpisodeEvidenceModule(createMemoryStorage(database, actor), options).search(
        input,
      );
    },
  };
}

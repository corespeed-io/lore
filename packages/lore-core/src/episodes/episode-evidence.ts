import { type ActorContext, installActorContext } from "../actor-context";
import type { PostgresDatabase, PostgresTransaction } from "../db";
import { embeddingVectorLiteral, embeddingVectorLiterals } from "../embedding/vector";
import type { EmbeddingProvider } from "../memory";
import { chunkMemoryContent, MEMORY_CHUNKING_REVISION } from "../memory-chunking";
import type { QueryPlanningProvider } from "../query-planning";
import type { RerankingProvider } from "../reranking";

export const EPISODE_EVIDENCE_INDEX_REVISION =
  `lore-episode-evidence-v1+${MEMORY_CHUNKING_REVISION}` as const;
export const EPISODE_EVIDENCE_RETRIEVAL_POLICY = {
  revision: "episode-hybrid-grouped-evidence-v1",
  candidateGeneration: "independent-rls-and-source-scoped-lexical-dense",
  fusion: "weighted-rrf-with-optional-planning-and-reranking",
  grouping: "episode-or-explicit-metadata-source-key",
} as const;

export class EpisodeEvidenceAccessDeniedError extends Error {
  override name = "EpisodeEvidenceAccessDeniedError";
  readonly status = 403;
}

export interface IndexEpisodeEvidence {
  episodeId: string;
  mode?: "build" | "verify";
}

export interface EpisodeEvidenceIndexResult {
  episodeId: string;
  observationCount: number;
  chunkCount: number;
  embeddedChunkCount: number;
  sourceCharacters: number;
  indexRevision: typeof EPISODE_EVIDENCE_INDEX_REVISION;
  embeddingGenerationId: string | null;
  embeddingGenerationStatus: "active" | "retiring" | null;
}

export interface SearchEpisodeEvidence {
  query: string;
  limit?: number;
  metadataFilter?: Record<string, unknown>;
  groupMetadataKey?: string;
  sourceKeys?: readonly string[];
}

export interface EpisodeEvidenceSearchResult {
  sourceKey: string;
  episodeIds: string[];
  observationIds: string[];
  metadata: Record<string, unknown>;
  evidence: string;
  score: number;
  rerankScore?: number;
}

export interface EpisodeEvidenceModuleOptions {
  embeddingProvider?: EmbeddingProvider;
  evidenceNeighborChunks?: number;
  evidenceTopObservations?: number;
  queryPlanningProvider?: QueryPlanningProvider;
  queryPlannerMaxQueries?: number;
  rerankingProvider?: RerankingProvider;
  rerankCandidateLimit?: number;
  rerankMinimumScore?: number;
  rerankWeight?: number;
  semanticDistanceThreshold?: number;
}

interface EpisodeRow {
  id: string;
}

interface ObservationRow {
  id: string;
  episode_id: string;
  ordinal: number;
  content: string;
  metadata: Record<string, unknown>;
}

interface PreparedEvidenceChunk {
  observationId: string;
  observationOrdinal: number;
  chunkOrdinal: number;
  content: string;
}

interface PersistedEvidenceChunk {
  id: string;
  episode_id: string;
  observation_id: string;
  observation_ordinal: number;
  chunk_ordinal: number;
  content: string;
}

interface SearchRow {
  episode_id: string;
  observation_id: string;
  metadata: Record<string, unknown>;
  evidence: string;
  score: number | string;
}

const embeddingBatchSize = 32;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`Expected an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`Expected a number from ${minimum} to ${maximum}`);
  }
  return selected;
}

function sourceKeyFor(row: SearchRow, groupMetadataKey: string | undefined): string {
  if (!groupMetadataKey) return row.episode_id;
  const value = row.metadata[groupMetadataKey];
  if (typeof value !== "string" || !value) {
    throw new Error(`Episode evidence metadata is missing ${groupMetadataKey}`);
  }
  return value;
}

async function readWritableEpisode(
  transaction: PostgresTransaction,
  actor: ActorContext,
  episodeId: string,
): Promise<{ episode: EpisodeRow; observations: ObservationRow[] }> {
  const episode = await transaction.query<EpisodeRow>(
    `SELECT id
     FROM episodes
     WHERE workspace_id = $1
       AND id = $2
       AND lore.can_write_memory(workspace_id, owner_user_id)`,
    [actor.workspaceId, episodeId],
  );
  if (!episode.rows[0]) {
    throw new EpisodeEvidenceAccessDeniedError("Actor cannot index this Episode");
  }
  const observations = await transaction.query<ObservationRow>(
    `SELECT id, episode_id, ordinal, content, metadata
     FROM observations
     WHERE workspace_id = $1 AND episode_id = $2
     ORDER BY ordinal, id`,
    [actor.workspaceId, episodeId],
  );
  if (!observations.rows.length) throw new Error("Episode contains no visible Observations");
  return { episode: episode.rows[0], observations: observations.rows };
}

function prepareChunks(observations: readonly ObservationRow[]): PreparedEvidenceChunk[] {
  return observations.flatMap((observation) =>
    chunkMemoryContent(observation.content).map((content, chunkOrdinal) => ({
      observationId: observation.id,
      observationOrdinal: observation.ordinal,
      chunkOrdinal,
      content,
    })),
  );
}

function validatePersistedChunks(
  expected: readonly PreparedEvidenceChunk[],
  persisted: readonly PersistedEvidenceChunk[],
): void {
  if (expected.length !== persisted.length) {
    throw new Error("Episode evidence failed exact reconstruction validation");
  }
  for (const [index, expectedChunk] of expected.entries()) {
    const actual = persisted[index];
    if (
      actual.observation_id !== expectedChunk.observationId ||
      actual.observation_ordinal !== expectedChunk.observationOrdinal ||
      actual.chunk_ordinal !== expectedChunk.chunkOrdinal ||
      actual.content !== expectedChunk.content
    ) {
      throw new Error("Episode evidence failed exact reconstruction validation");
    }
  }
}

async function matchingGeneration(
  transaction: PostgresTransaction,
  embeddingProvider: EmbeddingProvider,
  create: boolean,
): Promise<{ id: string; status: "active" | "retiring" } | null> {
  const result = create
    ? await transaction.query<{ id: string; status: string }>(
        "SELECT * FROM lore.ensure_embedding_generation($1, $2, $3, $4)",
        [
          embeddingProvider.provider,
          embeddingProvider.model,
          embeddingProvider.dimensions,
          embeddingProvider.revision,
        ],
      )
    : await transaction.query<{ id: string; status: string }>(
        `SELECT id, status
         FROM embedding_generations
         WHERE embedding_provider = $1
           AND embedding_model = $2
           AND embedding_dimensions = $3
           AND embedding_revision = $4
           AND status IN ('active', 'retiring')`,
        [
          embeddingProvider.provider,
          embeddingProvider.model,
          embeddingProvider.dimensions,
          embeddingProvider.revision,
        ],
      );
  const row = result.rows[0];
  return row && (row.status === "active" || row.status === "retiring")
    ? { id: row.id, status: row.status }
    : null;
}

async function persistedChunks(
  transaction: PostgresTransaction,
  actor: ActorContext,
  episodeId: string,
): Promise<PersistedEvidenceChunk[]> {
  const result = await transaction.query<PersistedEvidenceChunk>(
    `SELECT id, episode_id, observation_id, observation_ordinal, chunk_ordinal, content
     FROM episode_evidence_chunks
     WHERE workspace_id = $1
       AND episode_id = $2
       AND index_revision = $3
     ORDER BY observation_ordinal, observation_id, chunk_ordinal, id`,
    [actor.workspaceId, episodeId, EPISODE_EVIDENCE_INDEX_REVISION],
  );
  return result.rows;
}

async function embeddedChunkCount(
  transaction: PostgresTransaction,
  actor: ActorContext,
  episodeId: string,
  generationId: string,
): Promise<number> {
  const result = await transaction.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM episode_evidence_chunk_embeddings embedded
     JOIN episode_evidence_chunks chunk
       ON chunk.id = embedded.chunk_id
      AND chunk.workspace_id = embedded.workspace_id
     WHERE embedded.workspace_id = $1
       AND embedded.episode_id = $2
       AND embedded.generation_id = $3
       AND chunk.index_revision = $4`,
    [actor.workspaceId, episodeId, generationId, EPISODE_EVIDENCE_INDEX_REVISION],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function groupRows(
  rows: readonly SearchRow[],
  groupMetadataKey: string | undefined,
  evidenceTopObservations: number,
  limit: number,
): EpisodeEvidenceSearchResult[] {
  const groups = new Map<string, EpisodeEvidenceSearchResult>();
  for (const row of rows) {
    const sourceKey = sourceKeyFor(row, groupMetadataKey);
    const existing = groups.get(sourceKey);
    if (!existing) {
      groups.set(sourceKey, {
        sourceKey,
        episodeIds: [row.episode_id],
        observationIds: [row.observation_id],
        metadata: row.metadata,
        evidence: row.evidence,
        score: Number(row.score),
      });
      continue;
    }
    if (!existing.episodeIds.includes(row.episode_id)) existing.episodeIds.push(row.episode_id);
    if (
      existing.observationIds.length < evidenceTopObservations &&
      !existing.observationIds.includes(row.observation_id)
    ) {
      existing.observationIds.push(row.observation_id);
      existing.evidence += `\n\n${row.evidence}`;
    }
    existing.score = Math.max(existing.score, Number(row.score));
  }
  return [...groups.values()].slice(0, limit);
}

async function searchOneQuery(input: {
  transaction: PostgresTransaction;
  actor: ActorContext;
  query: string;
  queryEmbedding: string | null;
  candidateLimit: number;
  resultLimit: number;
  semanticDistanceThreshold: number;
  evidenceNeighborChunks: number;
  evidenceTopObservations: number;
  metadataFilter: Record<string, unknown> | null;
  groupMetadataKey?: string;
  sourceKeys: readonly string[];
  embeddingProvider?: EmbeddingProvider;
}): Promise<EpisodeEvidenceSearchResult[]> {
  const result = await input.transaction.query<SearchRow>(
    `WITH simple_lexical_candidates AS (
       SELECT
         chunk.id AS chunk_id,
         chunk.episode_id,
         chunk.observation_id,
         row_number() OVER (
           ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', $1), 32) DESC,
                    observation.observed_at DESC, chunk.observation_ordinal DESC,
                    chunk.chunk_ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM episode_evidence_chunks chunk
       JOIN observations observation
         ON observation.id = chunk.observation_id
        AND observation.workspace_id = chunk.workspace_id
       JOIN episodes episode
         ON episode.id = chunk.episode_id
        AND episode.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2
         AND chunk.index_revision = $11
         AND ($9::jsonb IS NULL OR observation.metadata @> $9::jsonb)
         AND (
           $10::text IS NULL
           OR cardinality($12::text[]) = 0
           OR observation.metadata->>$10 = ANY($12::text[])
         )
         AND chunk.search_vector @@ websearch_to_tsquery('simple', $1)
       ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', $1), 32) DESC,
                observation.observed_at DESC, chunk.observation_ordinal DESC,
                chunk.chunk_ordinal DESC, chunk.id
       LIMIT $4
     ),
     english_lexical_candidates AS (
       SELECT
         chunk.id AS chunk_id,
         chunk.episode_id,
         chunk.observation_id,
         row_number() OVER (
           ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', $1), 32) DESC,
                    observation.observed_at DESC, chunk.observation_ordinal DESC,
                    chunk.chunk_ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM episode_evidence_chunks chunk
       JOIN observations observation
         ON observation.id = chunk.observation_id
        AND observation.workspace_id = chunk.workspace_id
       JOIN episodes episode
         ON episode.id = chunk.episode_id
        AND episode.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2
         AND chunk.index_revision = $11
         AND ($9::jsonb IS NULL OR observation.metadata @> $9::jsonb)
         AND (
           $10::text IS NULL
           OR cardinality($12::text[]) = 0
           OR observation.metadata->>$10 = ANY($12::text[])
         )
         AND chunk.search_vector_english @@ websearch_to_tsquery('english', $1)
       ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', $1), 32) DESC,
                observation.observed_at DESC, chunk.observation_ordinal DESC,
                chunk.chunk_ordinal DESC, chunk.id
       LIMIT $4
     ),
     active_semantic_chunks AS MATERIALIZED (
       SELECT
         chunk.id,
         chunk.episode_id,
         chunk.observation_id,
         chunk.observation_ordinal,
         chunk.chunk_ordinal,
         observation.observed_at,
         embedded.embedding
       FROM episode_evidence_chunks chunk
       JOIN observations observation
         ON observation.id = chunk.observation_id
        AND observation.workspace_id = chunk.workspace_id
       JOIN episodes episode
         ON episode.id = chunk.episode_id
        AND episode.workspace_id = chunk.workspace_id
       JOIN episode_evidence_chunk_embeddings embedded
         ON embedded.chunk_id = chunk.id
        AND embedded.workspace_id = chunk.workspace_id
       JOIN embedding_generations generation ON generation.id = embedded.generation_id
       WHERE $3::text IS NOT NULL
         AND chunk.workspace_id = $2
         AND chunk.index_revision = $11
         AND generation.embedding_provider = $6
         AND generation.embedding_model = $7
         AND generation.embedding_revision = $8
         AND generation.embedding_dimensions = 1024
         AND generation.status IN ('active', 'retiring')
         AND ($9::jsonb IS NULL OR observation.metadata @> $9::jsonb)
         AND (
           $10::text IS NULL
           OR cardinality($12::text[]) = 0
           OR observation.metadata->>$10 = ANY($12::text[])
         )
     ),
     semantic_candidates AS (
       SELECT
         chunk.id AS chunk_id,
         chunk.episode_id,
         chunk.observation_id,
         row_number() OVER (
           ORDER BY chunk.embedding <=> $3::vector(1024), chunk.observed_at DESC,
                    chunk.observation_ordinal DESC, chunk.chunk_ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM active_semantic_chunks chunk
       WHERE (chunk.embedding <=> $3::vector(1024)) <= $5
       ORDER BY chunk.embedding <=> $3::vector(1024), chunk.observed_at DESC,
                chunk.observation_ordinal DESC, chunk.chunk_ordinal DESC, chunk.id
       LIMIT $4
     ),
     reciprocal_rank AS (
       SELECT
         chunk_id,
         episode_id,
         observation_id,
         sum(1.0 / (60.0 + candidate_rank)) AS score
       FROM (
         SELECT * FROM simple_lexical_candidates
         UNION ALL
         SELECT * FROM english_lexical_candidates
         UNION ALL
         SELECT * FROM semantic_candidates
       ) candidates
       GROUP BY chunk_id, episode_id, observation_id
     ),
     ranked_observations AS (
       SELECT observation_id, episode_id, max(score) AS score
       FROM reciprocal_rank
       GROUP BY observation_id, episode_id
       ORDER BY max(score) DESC, observation_id
       LIMIT $13
     )
     SELECT
       ranked.episode_id,
       ranked.observation_id,
       observation.metadata,
       ranked.score,
       evidence.content AS evidence
     FROM ranked_observations ranked
     JOIN observations observation
       ON observation.id = ranked.observation_id
      AND observation.workspace_id = $2
     JOIN LATERAL (
       SELECT string_agg(selected.content, '' ORDER BY selected.chunk_ordinal, selected.id) AS content
       FROM (
         SELECT anchor_chunk.chunk_ordinal
         FROM reciprocal_rank anchor
         JOIN episode_evidence_chunks anchor_chunk ON anchor_chunk.id = anchor.chunk_id
         WHERE anchor.observation_id = ranked.observation_id
         ORDER BY anchor.score DESC, anchor_chunk.chunk_ordinal DESC, anchor.chunk_id
         LIMIT 1
       ) anchor
       JOIN episode_evidence_chunks selected
         ON selected.workspace_id = $2
        AND selected.observation_id = ranked.observation_id
        AND selected.index_revision = $11
        AND selected.chunk_ordinal BETWEEN anchor.chunk_ordinal - $14
                                       AND anchor.chunk_ordinal + $14
     ) evidence ON true
     ORDER BY ranked.score DESC, ranked.observation_id`,
    [
      input.query,
      input.actor.workspaceId,
      input.queryEmbedding,
      input.candidateLimit,
      input.semanticDistanceThreshold,
      input.embeddingProvider?.provider ?? "",
      input.embeddingProvider?.model ?? "",
      input.embeddingProvider?.revision ?? "",
      input.metadataFilter ? JSON.stringify(input.metadataFilter) : null,
      input.groupMetadataKey ?? null,
      EPISODE_EVIDENCE_INDEX_REVISION,
      [...input.sourceKeys],
      input.resultLimit * input.evidenceTopObservations * 4,
      input.evidenceNeighborChunks,
    ],
  );
  return groupRows(
    result.rows,
    input.groupMetadataKey,
    input.evidenceTopObservations,
    input.resultLimit,
  );
}

function retrievalQueries(original: string, planned: readonly string[], maximum: number): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [original, ...planned]) {
    const query = candidate.trim();
    const key = query.toLocaleLowerCase("en-US");
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= maximum) break;
  }
  return queries;
}

function fuseQueryResults(
  resultSets: readonly EpisodeEvidenceSearchResult[][],
  limit: number,
): EpisodeEvidenceSearchResult[] {
  const fused = new Map<string, { result: EpisodeEvidenceSearchResult; score: number }>();
  for (const results of resultSets) {
    for (const [rank, result] of results.entries()) {
      const current = fused.get(result.sourceKey);
      const score = (current?.score ?? 0) + 1 / (60 + rank + 1);
      fused.set(result.sourceKey, { result: current?.result ?? result, score });
    }
  }
  return [...fused.values()]
    .map(({ result, score }) => ({ ...result, score }))
    .sort(
      (left, right) => right.score - left.score || left.sourceKey.localeCompare(right.sourceKey),
    )
    .slice(0, limit);
}

async function rerankResults(input: {
  query: string;
  results: EpisodeEvidenceSearchResult[];
  provider: RerankingProvider;
  limit: number;
  minimumScore: number;
  weight: number;
}): Promise<EpisodeEvidenceSearchResult[]> {
  const reranked = await input.provider.rerank({
    query: input.query,
    documents: input.results.map((result) => ({ id: result.sourceKey, text: result.evidence })),
    limit: input.results.length,
  });
  if (reranked.length !== input.results.length) {
    throw new Error("Reranking provider returned the wrong number of results");
  }
  const originalById = new Map(
    input.results.map((result, rank) => [result.sourceKey, { result, rank }]),
  );
  const seen = new Set<string>();
  const scored = reranked.map((candidate, rerankRank) => {
    const original = originalById.get(candidate.documentId);
    if (
      !original ||
      seen.has(candidate.documentId) ||
      !Number.isFinite(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 1
    ) {
      throw new Error("Reranking provider returned an invalid result");
    }
    seen.add(candidate.documentId);
    return {
      ...original.result,
      score: (1 - input.weight) / (60 + original.rank + 1) + input.weight / (60 + rerankRank + 1),
      rerankScore: candidate.score,
    };
  });
  return scored
    .filter((result) => (result.rerankScore ?? 0) >= input.minimumScore)
    .sort(
      (left, right) => right.score - left.score || left.sourceKey.localeCompare(right.sourceKey),
    )
    .slice(0, input.limit);
}

export function createEpisodeEvidenceModule(
  database: PostgresDatabase,
  options: EpisodeEvidenceModuleOptions = {},
) {
  const evidenceNeighborChunks = boundedInteger(options.evidenceNeighborChunks, 0, 0, 2);
  const evidenceTopObservations = boundedInteger(options.evidenceTopObservations, 1, 1, 5);
  const queryPlannerMaxQueries = boundedInteger(options.queryPlannerMaxQueries, 3, 1, 5);
  const rerankCandidateLimit = boundedInteger(options.rerankCandidateLimit, 50, 1, 200);
  const rerankMinimumScore = boundedNumber(options.rerankMinimumScore, 0, 0, 1);
  const rerankWeight = boundedNumber(options.rerankWeight, 1, 0, 1);
  const semanticDistanceThreshold = boundedNumber(options.semanticDistanceThreshold, 0.5, 0, 2);
  const embeddingProvider = options.embeddingProvider;

  return {
    async index(
      actor: ActorContext,
      input: IndexEpisodeEvidence,
    ): Promise<EpisodeEvidenceIndexResult> {
      const source = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        return readWritableEpisode(transaction, actor, input.episodeId);
      });
      const expectedChunks = prepareChunks(source.observations);
      const sourceCharacters = source.observations.reduce(
        (total, observation) => total + Array.from(observation.content).length,
        0,
      );

      if (input.mode !== "verify") {
        await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          await readWritableEpisode(transaction, actor, input.episodeId);
          await transaction.query(
            `INSERT INTO episode_evidence_chunks (
               workspace_id, episode_id, observation_id, observation_ordinal,
               chunk_ordinal, content, index_revision
             )
             SELECT $1, $2, input.observation_id, input.observation_ordinal,
                    input.chunk_ordinal, input.content, $3
             FROM jsonb_to_recordset($4::jsonb) AS input(
               observation_id uuid,
               observation_ordinal integer,
               chunk_ordinal integer,
               content text
             )
             ON CONFLICT (workspace_id, observation_id, index_revision, chunk_ordinal)
             DO NOTHING`,
            [
              actor.workspaceId,
              input.episodeId,
              EPISODE_EVIDENCE_INDEX_REVISION,
              JSON.stringify(
                expectedChunks.map((chunk) => ({
                  observation_id: chunk.observationId,
                  observation_ordinal: chunk.observationOrdinal,
                  chunk_ordinal: chunk.chunkOrdinal,
                  content: chunk.content,
                })),
              ),
            ],
          );
        });
      }

      const persisted = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        return persistedChunks(transaction, actor, input.episodeId);
      });
      validatePersistedChunks(expectedChunks, persisted);

      let generation: { id: string; status: "active" | "retiring" } | null = null;
      if (embeddingProvider) {
        generation = await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          return matchingGeneration(transaction, embeddingProvider, input.mode !== "verify");
        });
        if (input.mode === "verify" && !generation) {
          throw new Error("Episode evidence has no active compatible embedding generation");
        }
      }

      if (embeddingProvider && generation && input.mode !== "verify") {
        const missing = await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const result = await transaction.query<PersistedEvidenceChunk>(
            `SELECT chunk.id, chunk.episode_id, chunk.observation_id,
                    chunk.observation_ordinal, chunk.chunk_ordinal, chunk.content
             FROM episode_evidence_chunks chunk
             WHERE chunk.workspace_id = $1
               AND chunk.episode_id = $2
               AND chunk.index_revision = $3
               AND NOT EXISTS (
                 SELECT 1
                 FROM episode_evidence_chunk_embeddings embedded
                 WHERE embedded.generation_id = $4 AND embedded.chunk_id = chunk.id
               )
             ORDER BY chunk.observation_ordinal, chunk.observation_id, chunk.chunk_ordinal, chunk.id`,
            [actor.workspaceId, input.episodeId, EPISODE_EVIDENCE_INDEX_REVISION, generation.id],
          );
          return result.rows;
        });
        for (let offset = 0; offset < missing.length; offset += embeddingBatchSize) {
          const batch = missing.slice(offset, offset + embeddingBatchSize);
          let vectors: string[];
          try {
            vectors = embeddingVectorLiterals(
              await embeddingProvider.embed(
                batch.map((chunk) => chunk.content),
                "document",
              ),
              batch.length,
            );
          } catch {
            break;
          }
          await database.transaction(async (transaction) => {
            await installActorContext(transaction, actor);
            await transaction.query(
              `INSERT INTO episode_evidence_chunk_embeddings (
                 generation_id, workspace_id, episode_id, observation_id, chunk_id, embedding
               )
               SELECT $1, $2, input.episode_id, input.observation_id,
                      input.chunk_id, input.embedding::vector(1024)
               FROM jsonb_to_recordset($3::jsonb) AS input(
                 episode_id uuid,
                 observation_id uuid,
                 chunk_id uuid,
                 embedding text
               )
               ON CONFLICT (generation_id, chunk_id) DO NOTHING`,
              [
                generation?.id,
                actor.workspaceId,
                JSON.stringify(
                  batch.map((chunk, index) => ({
                    episode_id: chunk.episode_id,
                    observation_id: chunk.observation_id,
                    chunk_id: chunk.id,
                    embedding: vectors[index],
                  })),
                ),
              ],
            );
          });
        }
      }

      const embedded = generation
        ? await database.transaction(async (transaction) => {
            await installActorContext(transaction, actor);
            return embeddedChunkCount(transaction, actor, input.episodeId, generation.id);
          })
        : 0;
      if (input.mode === "verify" && embeddingProvider && embedded !== expectedChunks.length) {
        throw new Error("Episode evidence embedding coverage is incomplete");
      }
      return {
        episodeId: input.episodeId,
        observationCount: source.observations.length,
        chunkCount: expectedChunks.length,
        embeddedChunkCount: embedded,
        sourceCharacters,
        indexRevision: EPISODE_EVIDENCE_INDEX_REVISION,
        embeddingGenerationId: generation?.id ?? null,
        embeddingGenerationStatus: generation?.status ?? null,
      };
    },

    async search(
      actor: ActorContext,
      input: SearchEpisodeEvidence,
    ): Promise<EpisodeEvidenceSearchResult[]> {
      const query = input.query.trim();
      if (!query) return [];
      const limit = boundedInteger(input.limit, 10, 1, 100);
      const sourceKeys = [...new Set(input.sourceKeys ?? [])];
      if (sourceKeys.length && !input.groupMetadataKey) {
        throw new TypeError("sourceKeys require groupMetadataKey");
      }
      if (sourceKeys.length > 1_000)
        throw new TypeError("At most 1000 source keys may be searched");
      const resultLimit = options.rerankingProvider ? Math.max(limit, rerankCandidateLimit) : limit;
      const candidateLimit = Math.min(resultLimit * 4, 800);
      let planned: string[] = [];
      if (options.queryPlanningProvider && queryPlannerMaxQueries > 1) {
        try {
          planned = await options.queryPlanningProvider.plan({
            query,
            maxQueries: queryPlannerMaxQueries - 1,
          });
        } catch {
          planned = [];
        }
      }
      const queries = retrievalQueries(query, planned, queryPlannerMaxQueries);
      const queryEmbeddings: Array<string | null> = [];
      for (const plannedQuery of queries) {
        if (!embeddingProvider) {
          queryEmbeddings.push(null);
          continue;
        }
        try {
          const vectors = await embeddingProvider.embed([plannedQuery], "query");
          queryEmbeddings.push(vectors[0] ? embeddingVectorLiteral(vectors[0]) : null);
        } catch {
          queryEmbeddings.push(null);
        }
      }
      const resultSets = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const sets: EpisodeEvidenceSearchResult[][] = [];
        for (const [index, plannedQuery] of queries.entries()) {
          sets.push(
            await searchOneQuery({
              transaction,
              actor,
              query: plannedQuery,
              queryEmbedding: queryEmbeddings[index] ?? null,
              candidateLimit,
              resultLimit,
              semanticDistanceThreshold,
              evidenceNeighborChunks,
              evidenceTopObservations,
              metadataFilter: input.metadataFilter ?? null,
              groupMetadataKey: input.groupMetadataKey,
              sourceKeys,
              embeddingProvider,
            }),
          );
        }
        return sets;
      });
      const fused = fuseQueryResults(resultSets, resultLimit);
      if (!options.rerankingProvider || fused.length === 0) return fused.slice(0, limit);
      try {
        return await rerankResults({
          query,
          results: fused,
          provider: options.rerankingProvider,
          limit,
          minimumScore: rerankMinimumScore,
          weight: rerankWeight,
        });
      } catch {
        return fused.slice(0, limit);
      }
    },
  };
}

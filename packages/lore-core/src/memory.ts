import { queryInRecordBatches } from "./batch";
import { type EmbeddingProvider, validatedEmbeddingDimensions } from "./capabilities";
import type {
  MemoryStorageContext,
  MemoryStorageScope,
  PostgresBatchOptions,
  PostgresStatement,
  PostgresTransaction,
} from "./db";
import { isPostgresAccessDenied, statement } from "./db";
import { MEMORY_CHUNKING_REVISION } from "./memory-chunking";
import {
  MemoryContentValidationError,
  memoryContentChunks,
  prepareMemoryContent,
} from "./memory-content";
import {
  memoryListLimit,
  memoryListOffset,
  memorySearchLimit,
  memorySearchQuery,
  validateMemoryMetadata,
  validateMemoryScope,
} from "./memory-input";
import type {
  ContextGroupExpansionOptions,
  InsertMemoryRecord,
  ListMemory,
  Memory,
  MemoryMaintenanceNotifier,
  MemoryModuleOptions,
  MemoryMutationOptions,
  MemoryRow,
  MemoryScope,
  MemorySearchResult,
  RememberMemory,
  SearchMemory,
  UpdateMemory,
} from "./memory-types";
import { RETRIEVAL_CONTEXT_GROUP_POLICY, RETRIEVAL_ENTITY_ALIAS_POLICY } from "./retrieval/policy";
import {
  cjkLexicalGrams,
  feedbackRetrievalQuery,
  relaxedEnglishTerms,
  retrievalQueries,
} from "./retrieval/query";
import {
  appendFeedbackResults,
  compactRerankEvidence,
  diversifyRerankedResults,
  fuseQueryResults,
  fuseRecencyResults,
  fuseRerankedResults,
  type InternalMemorySearchResult,
  rerankEvidence,
} from "./retrieval/ranking";
import { utcTimestampSql } from "./timestamp";
import { embeddingVectorLiteral } from "./vector";

export * from "./memory-types";
export * from "./retrieval/policy";

export class MemoryAccessDeniedError extends Error {
  override name = "MemoryAccessDeniedError";
}

export class MemoryVersionConflictError extends Error {
  override name = "MemoryVersionConflictError";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`Memory version changed (expected ${expectedVersion}, found ${actualVersion})`);
  }
}

interface SearchRow extends MemoryRow {
  score: number;
  evidence: string;
  rerank_evidence: string;
}

type EmbeddingJobMemory = Pick<
  MemoryRow,
  "id" | "owner_user_id" | "scope" | "version" | "workspace_id"
>;

// Bounds one bulk job INSERT's JSON parameter; each job row is a few hundred bytes.
const EMBEDDING_JOB_BATCH_SIZE = 5_000;

/**
 * Queue messages one committed transaction sends at most: ten Queue batches, like
 * one sweep. A bulk import's remaining jobs are delivered by the sweep.
 */
const MAXIMUM_COMMIT_NOTIFICATIONS = 1_000;

interface NormalizedContextGroupExpansion {
  groupMetadataKey: string;
  ordinalMetadataKey?: string;
  baseCandidateLimit: number;
  maximumGroups: number;
}

function metadataScalar(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function metadataOrdinal(
  metadata: Record<string, unknown>,
  key: string | undefined,
): number | null {
  if (!key) return null;
  const value = metadata[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeContextGroupExpansion(
  input: ContextGroupExpansionOptions | undefined,
): NormalizedContextGroupExpansion | undefined {
  if (!input) return undefined;
  const groupMetadataKey = input.groupMetadataKey.trim();
  const ordinalMetadataKey = input.ordinalMetadataKey?.trim() || undefined;
  if (!groupMetadataKey || groupMetadataKey.length > 100) {
    throw new Error("contextGroupExpansion.groupMetadataKey must contain 1 to 100 characters");
  }
  if (ordinalMetadataKey && ordinalMetadataKey.length > 100) {
    throw new Error("contextGroupExpansion.ordinalMetadataKey must contain at most 100 characters");
  }
  const baseCandidateLimit =
    input.baseCandidateLimit ?? RETRIEVAL_CONTEXT_GROUP_POLICY.defaultBaseCandidateLimit;
  if (!Number.isInteger(baseCandidateLimit) || baseCandidateLimit < 1 || baseCandidateLimit > 200) {
    throw new Error("contextGroupExpansion.baseCandidateLimit must be an integer from 1 to 200");
  }
  const maximumGroups = input.maximumGroups ?? RETRIEVAL_CONTEXT_GROUP_POLICY.defaultMaximumGroups;
  if (!Number.isInteger(maximumGroups) || maximumGroups < 1 || maximumGroups > 20) {
    throw new Error("contextGroupExpansion.maximumGroups must be an integer from 1 to 20");
  }
  return {
    groupMetadataKey,
    ...(ordinalMetadataKey ? { ordinalMetadataKey } : {}),
    baseCandidateLimit,
    maximumGroups,
  };
}

async function expandContextGroupResults(input: {
  transaction: PostgresTransaction;
  storageScope: MemoryStorageScope;
  results: InternalMemorySearchResult[];
  targetLimit: number;
  expansion: NormalizedContextGroupExpansion;
  evidenceNeighborChunks: number;
  evidenceTopChunks: number;
  scope: MemoryScope | null;
  updatedAfter: string | null;
  updatedBefore: string | null;
  metadataFilter: Record<string, unknown> | null;
}): Promise<InternalMemorySearchResult[]> {
  if (input.results.length === 0 || input.targetLimit <= 1) return input.results;
  const baseKeep = Math.min(
    input.results.length,
    input.targetLimit,
    input.expansion.baseCandidateLimit,
  );
  if (baseKeep >= input.targetLimit) return input.results.slice(0, input.targetLimit);
  const base = input.results.slice(0, baseKeep);
  const groups = new Map<
    string,
    { rank: number; seeds: Array<{ ordinal: number | null; timestamp: number }> }
  >();
  for (const [rank, result] of base.entries()) {
    const group = metadataScalar(result.memory.metadata, input.expansion.groupMetadataKey);
    if (!group) continue;
    const existing = groups.get(group);
    const seed = {
      ordinal: metadataOrdinal(result.memory.metadata, input.expansion.ordinalMetadataKey),
      timestamp: Date.parse(result.memory.updatedAt),
    };
    if (existing) {
      existing.seeds.push(seed);
      continue;
    }
    if (groups.size >= input.expansion.maximumGroups) continue;
    groups.set(group, { rank, seeds: [seed] });
  }
  if (groups.size === 0) return input.results.slice(0, input.targetLimit);

  const groupValues = [...groups.keys()];
  const excludedMemoryIds = input.results.map((result) => result.memory.id);
  const fetchLimit = Math.min(
    RETRIEVAL_CONTEXT_GROUP_POLICY.maximumFetchedMemories,
    Math.max(input.targetLimit * 4, input.targetLimit * groups.size),
  );
  // An expanded row has no retrieval anchor, so its leading chunk anchors both
  // passages. Answer evidence keeps the first evidenceTopChunks chunks; the
  // reranker sees only that anchor plus up to evidenceNeighborChunks following
  // chunks, matching an ordinary candidate's compact passage and never wider
  // than the returned evidence.
  // The last statement of the search's transaction: COMMIT travels with it.
  const [expanded] = await input.transaction.batch(
    [
      statement<SearchRow>(
        `SELECT
       ${memorySelectColumns("memory")},
       0::double precision AS score,
       evidence.content AS evidence,
       evidence.rerank_content AS rerank_evidence
     FROM memories memory
     JOIN LATERAL (
       SELECT
         string_agg(selected.content, '' ORDER BY selected.ordinal) AS content,
         string_agg(selected.content, '' ORDER BY selected.ordinal)
           FILTER (WHERE selected.position <= $11::integer + 1) AS rerank_content
       FROM (
         SELECT
           chunk.content,
           chunk.ordinal,
           row_number() OVER (ORDER BY chunk.ordinal) AS position
         FROM memory_chunks chunk
         WHERE chunk.workspace_id = $1
           AND chunk.memory_id = memory.id
         ORDER BY chunk.ordinal
         LIMIT $10
       ) selected
     ) evidence ON evidence.content IS NOT NULL
     WHERE memory.workspace_id = $1
       AND ($2::memory_scope IS NULL OR memory.scope = $2::memory_scope)
       AND ($3::timestamptz IS NULL OR memory.updated_at >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR memory.updated_at < $4::timestamptz)
       AND ($5::jsonb IS NULL OR memory.metadata @> $5::jsonb)
       AND (memory.metadata ->> $6) = ANY($7::text[])
       AND NOT (memory.id = ANY($8::uuid[]))
     ORDER BY
       array_position($7::text[], memory.metadata ->> $6),
       memory.updated_at DESC,
       memory.id
     LIMIT $9`,
        [
          input.storageScope.partitionId,
          input.scope,
          input.updatedAfter,
          input.updatedBefore,
          input.metadataFilter ? JSON.stringify(input.metadataFilter) : null,
          input.expansion.groupMetadataKey,
          groupValues,
          excludedMemoryIds,
          fetchLimit,
          input.evidenceTopChunks,
          input.evidenceNeighborChunks,
        ],
      ),
    ],
    { commit: true },
  );
  const rankedExpanded = expanded.rows
    .map((row) => {
      const result: InternalMemorySearchResult = {
        memory: memoryFromRow(row),
        score: 0,
        evidence: row.evidence,
        [rerankEvidence]: row.rerank_evidence,
      };
      const group = metadataScalar(result.memory.metadata, input.expansion.groupMetadataKey);
      const groupSeed = group ? groups.get(group) : undefined;
      const ordinal = metadataOrdinal(result.memory.metadata, input.expansion.ordinalMetadataKey);
      const timestamp = Date.parse(result.memory.updatedAt);
      const ordinalDistances =
        ordinal === null
          ? []
          : (groupSeed?.seeds ?? [])
              .map((seed) => seed.ordinal)
              .filter((seedOrdinal): seedOrdinal is number => seedOrdinal !== null)
              .map((seedOrdinal) => Math.abs(ordinal - seedOrdinal));
      const distance = ordinalDistances.length
        ? Math.min(...ordinalDistances)
        : Math.min(...(groupSeed?.seeds ?? []).map((seed) => Math.abs(timestamp - seed.timestamp)));
      return {
        result,
        groupRank: groupSeed?.rank ?? Number.MAX_SAFE_INTEGER,
        distance: Number.isFinite(distance) ? distance : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.groupRank - right.groupRank ||
        left.result.memory.id.localeCompare(right.result.memory.id),
    );

  const selected: InternalMemorySearchResult[] = [...base];
  const selectedIds = new Set(selected.map((result) => result.memory.id));
  for (const [index, candidate] of rankedExpanded.entries()) {
    if (selected.length >= input.targetLimit) break;
    if (selectedIds.has(candidate.result.memory.id)) continue;
    selectedIds.add(candidate.result.memory.id);
    selected.push({ ...candidate.result, score: 1 / (120 + index + 1) });
  }
  for (const result of input.results) {
    if (selected.length >= input.targetLimit) break;
    if (selectedIds.has(result.memory.id)) continue;
    selectedIds.add(result.memory.id);
    selected.push(result);
  }
  return selected;
}

/**
 * Serialize a driver-returned timestamp: a `Date` becomes UTC ISO-8601 and text
 * passes through unchanged. Exported for host extensions that map their own
 * row shapes (for example lore's Memory Proposals module).
 */
export function serializedTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * SQL select list for one `memories` row with canonical timestamps. Every
 * engine path that returns a Memory selects its row through it, so list,
 * detail, write, and search responses serialize the same row identically.
 * Host extensions should use it with {@link memoryFromRow}; a row selected
 * with `*` keeps the driver's millisecond `Date` values instead.
 */
export function memorySelectColumns(alias?: string): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return [
    ...[
      "id",
      "workspace_id",
      "owner_user_id",
      "created_by_agent_id",
      "scope",
      "content",
      "metadata",
      "version",
    ].map(column),
    `${utcTimestampSql(column("created_at"))} AS created_at`,
    `${utcTimestampSql(column("updated_at"))} AS updated_at`,
  ].join(", ");
}

async function embedRetrievalQueries(
  embeddingProvider: EmbeddingProvider | undefined,
  queries: string[],
  embeddingDimensions: number,
): Promise<Array<string | null>> {
  const embeddings: Array<string | null> = queries.map(() => null);
  if (!embeddingProvider || queries.length === 0) return embeddings;
  try {
    const vectors = await embeddingProvider.embed(queries, "query");
    if (vectors.length !== queries.length) {
      throw new Error("Embedding provider returned the wrong number of query vectors");
    }
    for (const [index, vector] of vectors.entries()) {
      // The validated module width: the SQL ::vector casts require it, and the
      // constructor guarantees the provider agrees.
      embeddings[index] = embeddingVectorLiteral(vector, embeddingDimensions);
    }
  } catch {
    embeddings.fill(null);
  }
  return embeddings;
}

interface SearchStatementInput {
  storageScope: MemoryStorageScope;
  query: string;
  queryEmbedding: string | null;
  embeddingDimensions: number;
  entityAliasRecall: boolean;
  candidateLimit: number;
  resultLimit: number;
  semanticDistanceThreshold: number;
  evidenceNeighborChunks: number;
  evidenceTopChunks: number;
  scope: MemoryScope | null;
  updatedAfter: string | null;
  updatedBefore: string | null;
  metadataFilter: Record<string, unknown> | null;
  excludedMemoryIds?: string[];
  embeddingProvider?: EmbeddingProvider | undefined;
}

/** One hybrid retrieval statement; independent queries can share a batch. */
function searchStatement(input: SearchStatementInput): PostgresStatement<SearchRow> {
  return statement<SearchRow>(
    `WITH simple_lexical_candidates AS (
       SELECT
         chunk.id AS chunk_id,
         memory.id AS memory_id,
         chunk.ordinal AS chunk_ordinal,
         memory.updated_at AS memory_updated_at,
         row_number() OVER (
           ORDER BY ts_rank_cd(
             chunk.search_vector,
             websearch_to_tsquery('simple', $1),
             32
           ) DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM memory_chunks chunk
       JOIN memories memory
         ON memory.id = chunk.memory_id
        AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2
         AND ($12::memory_scope IS NULL OR memory.scope = $12::memory_scope)
         AND ($13::timestamptz IS NULL OR memory.updated_at >= $13::timestamptz)
         AND ($14::timestamptz IS NULL OR memory.updated_at < $14::timestamptz)
         AND ($15::jsonb IS NULL OR memory.metadata @> $15::jsonb)
         AND NOT (memory.id = ANY($16::uuid[]))
         AND chunk.search_vector @@ websearch_to_tsquery('simple', $1)
       ORDER BY ts_rank_cd(
         chunk.search_vector,
         websearch_to_tsquery('simple', $1),
         32
       ) DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $4
     ),
     english_lexical_candidates AS (
       SELECT
         chunk.id AS chunk_id,
         memory.id AS memory_id,
         chunk.ordinal AS chunk_ordinal,
         memory.updated_at AS memory_updated_at,
         row_number() OVER (
           ORDER BY ts_rank_cd(
             chunk.search_vector_english,
             websearch_to_tsquery('english', $1),
             32
           ) DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM memory_chunks chunk
       JOIN memories memory
         ON memory.id = chunk.memory_id
        AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2
         AND ($12::memory_scope IS NULL OR memory.scope = $12::memory_scope)
         AND ($13::timestamptz IS NULL OR memory.updated_at >= $13::timestamptz)
         AND ($14::timestamptz IS NULL OR memory.updated_at < $14::timestamptz)
         AND ($15::jsonb IS NULL OR memory.metadata @> $15::jsonb)
         AND NOT (memory.id = ANY($16::uuid[]))
         AND chunk.search_vector_english @@ websearch_to_tsquery('english', $1)
       ORDER BY ts_rank_cd(
         chunk.search_vector_english,
         websearch_to_tsquery('english', $1),
         32
       ) DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $4
     ),
     english_query_terms AS MATERIALIZED (
       SELECT
         plainto_tsquery('english', term) AS query,
         max(
           CASE
             WHEN term ~ '^[[:upper:]][[:lower:]]' THEN 4.0
             WHEN term ~ '[[:digit:]]' THEN 3.0
             WHEN char_length(term) >= 10 THEN 1.5
             ELSE 1.0
           END
         ) AS weight
       FROM unnest($10::text[]) AS term
       WHERE numnode(plainto_tsquery('english', term)) > 0
       GROUP BY plainto_tsquery('english', term)
     ),
     query_entity_aliases AS MATERIALIZED (
       SELECT alias
       FROM unnest(lore.extract_entity_aliases($1)) WITH ORDINALITY AS extracted(alias, ordinal)
       WHERE $18::boolean
       ORDER BY ordinal
       LIMIT ${RETRIEVAL_ENTITY_ALIAS_POLICY.maximumQueryAliases}
     ),
     entity_alias_matches AS MATERIALIZED (
       SELECT
         chunk.id AS chunk_id,
         memory.id AS memory_id,
         chunk.ordinal AS chunk_ordinal,
         memory.updated_at AS memory_updated_at,
         count(*) AS alias_match_count,
         max(char_length(query_alias.alias)) AS alias_specificity
       FROM query_entity_aliases query_alias
       JOIN memory_chunks chunk
         ON chunk.entity_aliases @> ARRAY[query_alias.alias]::text[]
       JOIN memories memory
         ON memory.id = chunk.memory_id
        AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2
         AND ($12::memory_scope IS NULL OR memory.scope = $12::memory_scope)
         AND ($13::timestamptz IS NULL OR memory.updated_at >= $13::timestamptz)
         AND ($14::timestamptz IS NULL OR memory.updated_at < $14::timestamptz)
         AND ($15::jsonb IS NULL OR memory.metadata @> $15::jsonb)
         AND NOT (memory.id = ANY($16::uuid[]))
       GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
       ORDER BY count(*) DESC, max(char_length(query_alias.alias)) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $4
     ),
     entity_alias_candidates AS (
       SELECT
         chunk_id,
         memory_id,
         chunk_ordinal,
         memory_updated_at,
         row_number() OVER (
           ORDER BY alias_match_count DESC, alias_specificity DESC,
                    memory_updated_at DESC, chunk_ordinal DESC, chunk_id
         ) AS candidate_rank
       FROM entity_alias_matches
     ),
     relaxed_english_lexical_candidates AS (
       SELECT
         chunk.id AS chunk_id,
         memory.id AS memory_id,
         chunk.ordinal AS chunk_ordinal,
         memory.updated_at AS memory_updated_at,
         row_number() OVER (
           ORDER BY sum(ts_rank_cd(chunk.search_vector_english, term.query, 32) * term.weight) DESC,
                    memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM memory_chunks chunk
       JOIN memories memory
         ON memory.id = chunk.memory_id
        AND memory.workspace_id = chunk.workspace_id
       JOIN english_query_terms term
         ON chunk.search_vector_english @@ term.query
       WHERE chunk.workspace_id = $2
         AND ($12::memory_scope IS NULL OR memory.scope = $12::memory_scope)
         AND ($13::timestamptz IS NULL OR memory.updated_at >= $13::timestamptz)
         AND ($14::timestamptz IS NULL OR memory.updated_at < $14::timestamptz)
         AND ($15::jsonb IS NULL OR memory.metadata @> $15::jsonb)
         AND NOT (memory.id = ANY($16::uuid[]))
       GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
       HAVING count(*) >= 2
       ORDER BY sum(ts_rank_cd(chunk.search_vector_english, term.query, 32) * term.weight) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $4
     ),
     cjk_lexical_matches AS MATERIALIZED (
       SELECT
         chunk.id AS chunk_id,
         memory.id AS memory_id,
         chunk.ordinal AS chunk_ordinal,
         memory.updated_at AS memory_updated_at,
         sum(char_length(gram.gram)) AS gram_specificity,
         count(*) AS gram_match_count
       FROM unnest($19::text[]) AS gram(gram)
       JOIN memory_chunks chunk
         ON chunk.content LIKE ('%' || gram.gram || '%')
       JOIN memories memory
         ON memory.id = chunk.memory_id
        AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2
         AND ($12::memory_scope IS NULL OR memory.scope = $12::memory_scope)
         AND ($13::timestamptz IS NULL OR memory.updated_at >= $13::timestamptz)
         AND ($14::timestamptz IS NULL OR memory.updated_at < $14::timestamptz)
         AND ($15::jsonb IS NULL OR memory.metadata @> $15::jsonb)
         AND NOT (memory.id = ANY($16::uuid[]))
       GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
       HAVING count(*) >= least(2, cardinality($19::text[]))
       ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $4
     ),
     cjk_lexical_candidates AS (
       SELECT
         chunk_id,
         memory_id,
         chunk_ordinal,
         memory_updated_at,
         row_number() OVER (
           ORDER BY gram_specificity DESC, gram_match_count DESC,
                    memory_updated_at DESC, chunk_ordinal DESC, chunk_id
         ) AS candidate_rank
       FROM cjk_lexical_matches
     ),
     lexical_candidates AS (
       SELECT * FROM simple_lexical_candidates
       UNION ALL
       SELECT * FROM english_lexical_candidates
       UNION ALL
       SELECT * FROM relaxed_english_lexical_candidates
       UNION ALL
       SELECT * FROM cjk_lexical_candidates
     ),
     active_semantic_chunks AS MATERIALIZED (
       SELECT
         chunk.id,
         chunk.memory_id,
         chunk.ordinal,
         memory.updated_at AS memory_updated_at,
         embedded.embedding
       FROM memory_chunks chunk
       JOIN memories memory
         ON memory.id = chunk.memory_id
        AND memory.workspace_id = chunk.workspace_id
       JOIN memory_chunk_embeddings embedded
         ON embedded.workspace_id = chunk.workspace_id
        AND embedded.memory_id = chunk.memory_id
        AND embedded.chunk_id = chunk.id
       JOIN embedding_generations generation
         ON generation.id = embedded.generation_id
       WHERE $3::text IS NOT NULL
         AND chunk.workspace_id = $2
         AND generation.embedding_provider = $7
         AND generation.embedding_model = $8
         AND generation.embedding_revision = $9
         AND generation.embedding_dimensions = ${input.embeddingDimensions}
         AND generation.status IN ('active', 'retiring')
         AND ($12::memory_scope IS NULL OR memory.scope = $12::memory_scope)
         AND ($13::timestamptz IS NULL OR memory.updated_at >= $13::timestamptz)
         AND ($14::timestamptz IS NULL OR memory.updated_at < $14::timestamptz)
         AND ($15::jsonb IS NULL OR memory.metadata @> $15::jsonb)
         AND NOT (memory.id = ANY($16::uuid[]))
     ),
     semantic_candidates AS (
       SELECT
         chunk.id AS chunk_id,
         chunk.memory_id,
         chunk.ordinal AS chunk_ordinal,
         chunk.memory_updated_at,
         row_number() OVER (
           ORDER BY chunk.embedding <=> $3::vector(${input.embeddingDimensions}),
                    chunk.memory_updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM active_semantic_chunks chunk
       WHERE (chunk.embedding <=> $3::vector(${input.embeddingDimensions})) <= $5
       ORDER BY chunk.embedding <=> $3::vector(${input.embeddingDimensions}),
                chunk.memory_updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $4
     ),
     reciprocal_rank AS (
       SELECT
         chunk_id,
         memory_id,
         chunk_ordinal,
         max(memory_updated_at) AS memory_updated_at,
         sum(1.0 / (60.0 + candidate_rank)) AS score
       FROM (
         SELECT * FROM lexical_candidates
         UNION ALL
         SELECT * FROM semantic_candidates
         UNION ALL
         SELECT * FROM entity_alias_candidates
       ) candidates
       GROUP BY chunk_id, memory_id, chunk_ordinal
     ),
     ranked_memories AS (
       SELECT
         memory_id,
         max(score) AS score,
         max(memory_updated_at) AS memory_updated_at
       FROM reciprocal_rank
       GROUP BY memory_id
       ORDER BY max(score) DESC, max(memory_updated_at) DESC, memory_id
       LIMIT $6
     )
     SELECT
       ${memorySelectColumns("memory")},
       ranked_memories.score,
       evidence.content AS evidence,
       rerank_evidence.content AS rerank_evidence
     FROM ranked_memories
     JOIN memories memory
       ON memory.id = ranked_memories.memory_id
      AND memory.workspace_id = $2
     JOIN LATERAL (
       SELECT string_agg(selected.content, '' ORDER BY selected.ordinal) AS content
       FROM memory_chunks selected
       WHERE selected.workspace_id = $2
         AND selected.memory_id = memory.id
         AND (
           (
             SELECT count(*)
             FROM memory_chunks sibling
             WHERE sibling.workspace_id = $2
               AND sibling.memory_id = memory.id
           ) <= $17::integer * (2 * $11::integer + 1)
           OR EXISTS (
             SELECT 1
             FROM (
               SELECT chunk_id, chunk_ordinal
               FROM reciprocal_rank
               WHERE memory_id = memory.id
               ORDER BY score DESC, chunk_ordinal DESC, chunk_id
               LIMIT $17
             ) evidence_anchor
             WHERE selected.ordinal BETWEEN evidence_anchor.chunk_ordinal - $11::integer
                                        AND evidence_anchor.chunk_ordinal + $11::integer
           )
         )
     ) evidence ON true
     JOIN LATERAL (
       SELECT string_agg(selected.content, '' ORDER BY selected.ordinal) AS content
       FROM memory_chunks selected
       WHERE selected.workspace_id = $2
         AND selected.memory_id = memory.id
         AND EXISTS (
           SELECT 1
           FROM (
             SELECT chunk_ordinal
             FROM reciprocal_rank
             WHERE memory_id = memory.id
             ORDER BY score DESC, chunk_ordinal DESC, chunk_id
             LIMIT 1
           ) anchor
           WHERE selected.ordinal BETWEEN anchor.chunk_ordinal - $11::integer
                                      AND anchor.chunk_ordinal + $11::integer
         )
     ) rerank_evidence ON true
     ORDER BY ranked_memories.score DESC, memory.updated_at DESC, memory.id`,
    [
      input.query,
      input.storageScope.partitionId,
      input.queryEmbedding,
      input.candidateLimit,
      input.semanticDistanceThreshold,
      input.resultLimit,
      input.embeddingProvider?.provider ?? "",
      input.embeddingProvider?.model ?? "",
      input.embeddingProvider?.revision ?? "",
      relaxedEnglishTerms(input.query),
      input.evidenceNeighborChunks,
      input.scope,
      input.updatedAfter,
      input.updatedBefore,
      input.metadataFilter ? JSON.stringify(input.metadataFilter) : null,
      input.excludedMemoryIds ?? [],
      input.evidenceTopChunks,
      input.entityAliasRecall,
      cjkLexicalGrams(input.query),
    ],
  );
}

function searchResults(rows: readonly SearchRow[]): MemorySearchResult[] {
  return rows.map((row) => ({
    memory: memoryFromRow(row),
    score: Number(row.score),
    evidence: row.evidence,
    [rerankEvidence]: row.rerank_evidence,
  }));
}

/**
 * Insert a Memory's chunks in one statement. Ordinals follow the chunk order unless
 * `ordinals` names each chunk's own, as an update that replaces only some does.
 * Vectors live in generation-scoped memory_chunk_embeddings, so no per-chunk
 * embedding columns are written.
 */
function chunkInsertStatement(
  workspaceId: string,
  memoryId: string,
  chunks: readonly string[],
  ordinals: readonly number[] = chunks.map((_chunk, ordinal) => ordinal),
): PostgresStatement {
  return statement(
    `INSERT INTO memory_chunks (
       id, workspace_id, memory_id, ordinal, content, chunking_revision
     )
     SELECT chunk.id, $1::uuid, $2::uuid, chunk.ordinal, chunk.content, $6
     FROM unnest($3::uuid[], $4::integer[], $5::text[]) AS chunk(id, ordinal, content)`,
    [
      workspaceId,
      memoryId,
      chunks.map(() => crypto.randomUUID()),
      ordinals,
      chunks,
      MEMORY_CHUNKING_REVISION,
    ],
  );
}

/** One stored chunk as an update compares it with the new content's chunks. */
export interface StoredChunkRow {
  ordinal: number;
  content: string;
  chunking_revision: string;
}

/**
 * The ordinals an update must replace: every stored chunk whose text or chunking
 * revision differs from the new chunk at its ordinal, and the stored tail past the
 * new count are deleted; every new chunk with no identical stored chunk at its
 * ordinal is inserted. Chunks match by ordinal, never by content, because moving a
 * chunk would need `UPDATE … SET ordinal` against a non-deferrable unique key.
 */
function chunkReplacement(
  stored: readonly StoredChunkRow[],
  chunks: readonly string[],
): { deleted: number[]; inserted: { ordinals: number[]; chunks: string[] } } {
  const kept = new Set<number>();
  const deleted: number[] = [];
  for (const chunk of stored) {
    const ordinal = Number(chunk.ordinal);
    if (chunk.chunking_revision === MEMORY_CHUNKING_REVISION && chunks[ordinal] === chunk.content) {
      kept.add(ordinal);
    } else {
      deleted.push(ordinal);
    }
  }
  const inserted = { ordinals: [] as number[], chunks: [] as string[] };
  chunks.forEach((chunk, ordinal) => {
    if (kept.has(ordinal)) return;
    inserted.ordinals.push(ordinal);
    inserted.chunks.push(chunk);
  });
  return { deleted, inserted };
}

/**
 * Queue an embedding job for `memory`, resolving (and on first use creating) the
 * provider's generation in the same statement. With `onlyWhenStale`, the job is
 * inserted only when some chunk lacks a vector in that generation. The RETURNING
 * list names no column, so it needs no SELECT privilege on this private table and
 * reports exactly whether this statement inserted the job.
 */
function embeddingJobStatement(
  memory: EmbeddingJobMemory,
  jobId: string,
  embeddingProvider: EmbeddingProvider,
  onlyWhenStale: boolean,
): PostgresStatement<{ inserted: boolean }> {
  return statement<{ inserted: boolean }>(
    `INSERT INTO memory_embedding_jobs (
       id, workspace_id, memory_id, owner_user_id, memory_scope,
       memory_version, embedding_provider, embedding_model, embedding_revision,
       generation_id
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, generation.id
     FROM lore.ensure_embedding_generation($7, $8, $11, $9) generation
     WHERE NOT $10::boolean
        OR EXISTS (
          SELECT 1
          FROM memory_chunks chunk
          WHERE chunk.workspace_id = $2
            AND chunk.memory_id = $3
            AND NOT EXISTS (
              SELECT 1
              FROM memory_chunk_embeddings embedded
              WHERE embedded.generation_id = generation.id
                AND embedded.chunk_id = chunk.id
            )
        )
     RETURNING true AS inserted`,
    [
      jobId,
      memory.workspace_id,
      memory.id,
      memory.owner_user_id,
      memory.scope,
      memory.version,
      embeddingProvider.provider,
      embeddingProvider.model,
      embeddingProvider.revision,
      onlyWhenStale,
      embeddingProvider.dimensions,
    ],
  );
}

/** A batch record's chunks; a content refusal names the record that broke the rule. */
function batchRecordChunks(record: InsertMemoryRecord, index: number): readonly string[] {
  try {
    return memoryContentChunks(record.content, record.preparedContent);
  } catch (error) {
    if (!(error instanceof MemoryContentValidationError)) throw error;
    throw new MemoryContentValidationError(error.message, {
      cause: error,
      field: `records[${index}].content`,
    });
  }
}

/** List and search filters obey the same rules as the values they match. */
function validateReadFilters(input: {
  scope?: MemoryScope | undefined;
  metadataFilter?: Record<string, unknown> | undefined;
}): void {
  if (input.scope !== undefined) validateMemoryScope(input.scope);
  if (input.metadataFilter !== undefined) {
    validateMemoryMetadata(input.metadataFilter, "metadataFilter");
  }
}

/**
 * Map a raw `memories` row to the public {@link Memory} shape. Select the row
 * with {@link memorySelectColumns} so its timestamps use the canonical form.
 */
export function memoryFromRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    partitionId: row.workspace_id,
    ownerId: row.owner_user_id,
    sourceId: row.created_by_agent_id,
    scope: row.scope,
    content: row.content,
    metadata: row.metadata,
    version: row.version,
    createdAt: serializedTimestamp(row.created_at),
    updatedAt: serializedTimestamp(row.updated_at),
  };
}

/**
 * The row a write primitive's final batch is meant to leave: the Memory at this
 * version once the write applied, or none (`version: null`) once a delete applied.
 * A write can still match nothing in that batch, when the store stops letting the
 * caller write the row it locked (under RLS, a grant revoked meanwhile), so a host
 * whose `finish` statements record an outcome must check that the row is as meant.
 */
export interface WrittenMemory {
  id: string;
  version: number | null;
}

/**
 * How a single-Memory write primitive ends its final batch. `finish` adds the
 * host's own statements to it, after the write, so a host's completion (an
 * idempotency ledger row, say) costs no round trip of its own; they may read the
 * Memory row the batch just wrote. With `commit`, COMMIT follows them.
 */
export interface MemoryWriteBatchOptions extends PostgresBatchOptions {
  finish?: (written: WrittenMemory) => readonly PostgresStatement<unknown>[];
}

/**
 * A Memory row an update has locked (`lockMemoryInTransaction`). It stays locked
 * until the transaction ends, so the update applied to it cannot race.
 */
export interface LockedMemory {
  readonly row: MemoryRow;
  /** The update it was locked for, and what its locking read compared and fetched. */
  readonly input: UpdateMemory;
  readonly chunks: readonly string[] | null;
  readonly metadata: string | null;
  readonly metadataChanged: boolean;
  readonly storedChunks: readonly StoredChunkRow[] | null;
}

/** An update's final batch; `versionUnchanged` is described at the update primitive. */
export interface MemoryUpdateBatchOptions extends MemoryWriteBatchOptions {
  versionUnchanged?: boolean;
}

export interface MemoryMutationPrimitivesOptions {
  defaultMemoryScope?: MemoryScope;
  /** The host's vector width; must equal `embeddingProvider.dimensions` when both are set. */
  embeddingDimensions?: number;
  embeddingProvider?: EmbeddingProvider;
  maintenanceNotifier?: MemoryMaintenanceNotifier;
}

/** The configured vector width, refusing a provider that embeds at another one. */
function configuredEmbeddingDimensions(options: {
  embeddingDimensions?: number;
  embeddingProvider?: EmbeddingProvider;
}): number {
  const dimensions = validatedEmbeddingDimensions(
    options.embeddingDimensions ?? options.embeddingProvider?.dimensions ?? 1024,
  );
  if (options.embeddingProvider && options.embeddingProvider.dimensions !== dimensions) {
    throw new Error(
      "embeddingDimensions must match embeddingProvider.dimensions: " +
        `the module is configured for ${dimensions} but the provider embeds at ${options.embeddingProvider.dimensions}`,
    );
  }
  return dimensions;
}

/**
 * Transaction-scoped Memory write primitives shared by the Memory module and
 * host extensions that create or update canonical Memories inside their own
 * transactions (lore's Memory Proposals review is the canonical example).
 * Callers own the surrounding transaction, storage access policy,
 * authorization checks, and idempotency bookkeeping.
 *
 * Each single-Memory primitive sends its writes as one final batch. With
 * `{ commit: true }` that batch also commits the transaction, saving the host a
 * round trip, and nothing may run in the transaction afterwards.
 */
export function createMemoryMutationPrimitives(options: MemoryMutationPrimitivesOptions = {}) {
  configuredEmbeddingDimensions(options);
  const defaultMemoryScope = options.defaultMemoryScope ?? "shared";
  const embeddingProvider = options.embeddingProvider;
  const maintenanceNotifier = options.maintenanceNotifier;

  /**
   * Jobs this primitive set queued, per transaction. The first one registers a
   * single post-commit effect, so a host never sees job ids: a rolled-back
   * transaction notifies nothing, and a committed one sends at most
   * {@link MAXIMUM_COMMIT_NOTIFICATIONS} messages (the sweep finds the rest).
   */
  const queuedJobs = new WeakMap<PostgresTransaction, string[]>();

  function notifyAfterCommit(transaction: PostgresTransaction, jobIds: readonly string[]): void {
    if (jobIds.length === 0 || !maintenanceNotifier) return;
    let queued = queuedJobs.get(transaction);
    if (!queued) {
      const jobs: string[] = [];
      queued = jobs;
      queuedJobs.set(transaction, jobs);
      transaction.afterCommit(() => {
        const messages = jobs.slice(0, MAXIMUM_COMMIT_NOTIFICATIONS).map((jobId) => ({ jobId }));
        try {
          if (maintenanceNotifier.notifyMany) maintenanceNotifier.notifyMany(messages);
          else for (const message of messages) maintenanceNotifier.notify(message);
        } catch {
          // The durable Postgres job remains discoverable by the maintenance sweep.
          // A queue notification is only a latency optimization.
        }
      });
    }
    queued.push(...jobIds);
  }

  async function insertMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    input: RememberMemory,
    createdByAgentId: string | null = storageScope.sourceId ?? null,
    batchOptions: MemoryWriteBatchOptions = {},
  ): Promise<{ memory: Memory }> {
    const { chunks } = prepareMemoryContent(input.content);
    const scope = input.scope === undefined ? defaultMemoryScope : validateMemoryScope(input.scope);
    const metadata = input.metadata === undefined ? {} : validateMemoryMetadata(input.metadata);
    const id = crypto.randomUUID();
    const memoryInsert = statement<MemoryRow>(
      `INSERT INTO memories (
         id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING ${memorySelectColumns()}`,
      [
        id,
        storageScope.partitionId,
        storageScope.ownerId,
        createdByAgentId,
        scope,
        input.content,
        JSON.stringify(metadata),
      ],
    );
    const chunkInsert = chunkInsertStatement(storageScope.partitionId, id, chunks);
    // The Memory, its chunks, and its first embedding job share one round trip.
    // A new Memory always starts at version 1, which the job is fenced by.
    if (!embeddingProvider) {
      const [inserted] = await transaction.batch(
        [memoryInsert, chunkInsert, ...(batchOptions.finish?.({ id, version: 1 }) ?? [])],
        { commit: batchOptions.commit === true },
      );
      const memory = inserted.rows[0];
      if (!memory) throw new Error("Memory insert returned no row");
      return { memory: memoryFromRow(memory) };
    }
    const jobId = crypto.randomUUID();
    const [inserted, , job] = await transaction.batch(
      [
        memoryInsert,
        chunkInsert,
        embeddingJobStatement(
          {
            id,
            workspace_id: storageScope.partitionId,
            owner_user_id: storageScope.ownerId,
            scope,
            version: 1,
          },
          jobId,
          embeddingProvider,
          false,
        ),
        ...(batchOptions.finish?.({ id, version: 1 }) ?? []),
      ],
      { commit: batchOptions.commit === true },
    );
    const memory = inserted.rows[0];
    if (!memory) throw new Error("Memory insert returned no row");
    if (job.rows.length > 0) notifyAfterCommit(transaction, [jobId]);
    return { memory: memoryFromRow(memory) };
  }

  /**
   * Lock a Memory for an update, sending the locking read at once so it can share
   * a round trip with whatever the host sent before it. Under RLS a locking read
   * also applies the update policy's condition, so a Memory this store may read but
   * not write reads as absent (null) before any version check. When content is
   * given, the stored chunks are read behind the lock in the same round trip: each
   * statement of a batch takes its own snapshot, so this one sees the locked state.
   */
  async function lockMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    id: string,
    input: UpdateMemory,
  ): Promise<LockedMemory | null> {
    if (input.scope !== undefined) validateMemoryScope(input.scope);
    if (input.metadata !== undefined) validateMemoryMetadata(input.metadata);
    const chunks = input.content === undefined ? null : prepareMemoryContent(input.content).chunks;
    const metadata = input.metadata === undefined ? null : JSON.stringify(input.metadata);
    const [current, stored] = await transaction.batch([
      statement<MemoryRow & { metadata_changed: boolean }>(
        `SELECT ${memorySelectColumns()},
                ($3::jsonb IS NOT NULL AND metadata IS DISTINCT FROM $3::jsonb) AS metadata_changed
         FROM memories
         WHERE id = $1
           AND workspace_id = $2
         FOR UPDATE`,
        [id, storageScope.partitionId, metadata],
      ),
      ...(chunks === null
        ? []
        : [
            statement<StoredChunkRow>(
              `SELECT ordinal, content, chunking_revision
               FROM memory_chunks
               WHERE workspace_id = $2
                 AND memory_id = $1
               ORDER BY ordinal`,
              [id, storageScope.partitionId],
            ),
          ]),
    ]);
    const currentRow = current.rows[0];
    if (!currentRow) return null;
    const { metadata_changed: metadataChanged, ...row } = currentRow;
    return {
      row,
      input,
      chunks,
      metadata,
      metadataChanged,
      storedChunks: stored?.rows ?? null,
    };
  }

  /**
   * Update one Memory under a row lock: one locking read, which also fetches the
   * stored chunks when content is given, then one final batch. Returns null when
   * the store shows no such Memory, or one it may read but not write, before any
   * version check; throws MemoryVersionConflictError on a stale expected version.
   */
  async function updateMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    id: string,
    input: UpdateMemory,
    expectedVersion?: number,
    options: MemoryUpdateBatchOptions = {},
  ): Promise<{ changed: boolean; chunksChanged: boolean; memory: Memory } | null> {
    const locked = await lockMemoryInTransaction(transaction, storageScope, id, input);
    if (!locked) return null;
    return updateLockedMemoryInTransaction(
      transaction,
      storageScope,
      locked,
      expectedVersion,
      options,
    );
  }

  /**
   * Apply the update a Memory was locked for. Throws MemoryVersionConflictError on
   * a stale expected version.
   *
   * Only what actually differs is written. When content, scope, and metadata all
   * equal the locked row, nothing is written: the row comes back with its version
   * and `updatedAt`, no event is recorded, and no job is queued (the final batch
   * carries only the host's `finish` statements and, with `commit`, COMMIT).
   * Content changes replace only the chunks whose ordinals differ, so unchanged
   * chunks keep their ids and vectors; scope and metadata changes leave chunks
   * alone. A job for the new version is queued only when some chunk lacks a vector
   * in the serving generation; jobs for older versions are cancelled when claimed.
   *
   * `versionUnchanged` records a new version even when nothing differs, for a
   * host whose own receipt names the next version (lore's Memory Proposal
   * acceptance); chunks and jobs still follow the rules above.
   */
  async function updateLockedMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    locked: LockedMemory,
    expectedVersion?: number,
    options: MemoryUpdateBatchOptions = {},
  ): Promise<{ changed: boolean; chunksChanged: boolean; memory: Memory } | null> {
    const { row: currentMemory, input, chunks, metadata, metadataChanged } = locked;
    const stored = locked.storedChunks;
    const id = currentMemory.id;
    const commit = { commit: options.commit === true };
    if (expectedVersion !== undefined && currentMemory.version !== expectedVersion) {
      throw new MemoryVersionConflictError(expectedVersion, currentMemory.version);
    }
    const contentChanged = chunks !== null && input.content !== currentMemory.content;
    const scopeChanged = input.scope !== undefined && input.scope !== currentMemory.scope;
    const changed = contentChanged || scopeChanged || metadataChanged;
    if (!changed && options.versionUnchanged !== true) {
      await transaction.batch(
        options.finish?.({ id, version: currentMemory.version }) ?? [],
        commit,
      );
      return { memory: memoryFromRow(currentMemory), changed: false, chunksChanged: false };
    }
    // The row is locked, so everything after the read is known and shares one
    // round trip: the update, the replaced chunks, the job for the new version,
    // and the host's `finish` statements.
    const update = statement<MemoryRow>(
      `UPDATE memories
         SET content = COALESCE($3::text, content),
             scope = COALESCE($4::memory_scope, scope),
             metadata = COALESCE($5::jsonb, metadata),
             version = version + 1,
             updated_at = now()
         WHERE id = $1
           AND workspace_id = $2
           AND version = $6
         RETURNING ${memorySelectColumns()}`,
      [
        id,
        storageScope.partitionId,
        contentChanged ? input.content : null,
        scopeChanged ? input.scope : null,
        metadataChanged ? metadata : null,
        currentMemory.version,
      ],
    );
    const tail: PostgresStatement<unknown>[] = [];
    let chunksChanged = false;
    if (contentChanged && stored && chunks) {
      const { deleted, inserted } = chunkReplacement(stored, chunks);
      if (deleted.length > 0) {
        tail.push(
          statement(
            `DELETE FROM memory_chunks
             WHERE workspace_id = $1
               AND memory_id = $2
               AND ordinal = ANY($3::integer[])`,
            [storageScope.partitionId, id, deleted],
          ),
        );
      }
      if (inserted.chunks.length > 0) {
        tail.push(
          chunkInsertStatement(storageScope.partitionId, id, inserted.chunks, inserted.ordinals),
        );
      }
      chunksChanged = deleted.length > 0 || inserted.chunks.length > 0;
    }
    const jobId = crypto.randomUUID();
    if (embeddingProvider) {
      // Runs after the chunk writes, so it sees which chunks still lack a vector.
      tail.push(
        embeddingJobStatement(
          {
            id,
            workspace_id: currentMemory.workspace_id,
            owner_user_id: currentMemory.owner_user_id,
            scope: input.scope ?? currentMemory.scope,
            version: currentMemory.version + 1,
          },
          jobId,
          embeddingProvider,
          true,
        ),
      );
    }
    const results = await transaction.batch(
      [update, ...tail, ...(options.finish?.({ id, version: currentMemory.version + 1 }) ?? [])],
      commit,
    );
    const updatedMemory = results[0].rows[0];
    if (!updatedMemory) return null;
    // The job, when there is one, is the tail's last statement.
    if (embeddingProvider && (results[tail.length]?.rows.length ?? 0) > 0) {
      notifyAfterCommit(transaction, [jobId]);
    }
    return { memory: memoryFromRow(updatedMemory), changed, chunksChanged };
  }

  /**
   * Enqueue first-embedding jobs for Memories a host inserted, with their chunks,
   * in this transaction without {@link insertMemoryInTransaction} (for example a
   * bounded bulk import that batches its row inserts). Every listed Memory must be
   * new. The jobs' queue notifications go out after this transaction commits. Does
   * nothing without an embedding provider.
   */
  async function enqueueEmbeddingJobsInTransaction(
    transaction: PostgresTransaction,
    memories: readonly EmbeddingJobMemory[],
  ): Promise<void> {
    if (!embeddingProvider || memories.length === 0) return;
    for (let offset = 0; offset < memories.length; offset += EMBEDDING_JOB_BATCH_SIZE) {
      const jobs = memories.slice(offset, offset + EMBEDDING_JOB_BATCH_SIZE).map((memory) => ({
        id: crypto.randomUUID(),
        workspace_id: memory.workspace_id,
        memory_id: memory.id,
        owner_user_id: memory.owner_user_id,
        memory_scope: memory.scope,
        memory_version: memory.version,
      }));
      await transaction.query(
        `INSERT INTO memory_embedding_jobs (
           id, workspace_id, memory_id, owner_user_id, memory_scope,
           memory_version, embedding_provider, embedding_model, embedding_revision,
           generation_id
         )
         SELECT job.id, job.workspace_id, job.memory_id, job.owner_user_id, job.memory_scope,
                job.memory_version, $2, $3, $4, generation.id
         FROM lore.ensure_embedding_generation($2, $3, $5, $4) generation,
              jsonb_to_recordset($1::jsonb) AS job(
                id uuid, workspace_id uuid, memory_id uuid, owner_user_id uuid,
                memory_scope memory_scope, memory_version integer
              )`,
        [
          JSON.stringify(jobs),
          embeddingProvider.provider,
          embeddingProvider.model,
          embeddingProvider.revision,
          embeddingProvider.dimensions,
        ],
      );
      notifyAfterCommit(
        transaction,
        jobs.map((job) => job.id),
      );
    }
  }

  /**
   * Delete one Memory. Returns false when the store shows no such Memory, or one it
   * may read but not write (RLS skips it in the DELETE and in the locking read
   * alike, so write authority still precedes the version check). Throws
   * MemoryVersionConflictError on a stale expected version. Chunks, vectors, jobs,
   * and Links go with it through the schema's cascades. Under an expected version
   * the delete and a locking version read share one round trip: the read finds
   * nothing once the delete succeeded, and the current version after a miss.
   */
  async function forgetMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    id: string,
    options: { expectedVersion?: number | undefined } & PostgresBatchOptions = {},
  ): Promise<boolean> {
    const { expectedVersion } = options;
    const [deleted, current] = await transaction.batch(
      [
        statement<{ id: string }>(
          `DELETE FROM memories
           WHERE id = $1
             AND workspace_id = $2
             AND ($3::integer IS NULL OR version = $3::integer)
           RETURNING id`,
          [id, storageScope.partitionId, expectedVersion ?? null],
        ),
        ...(expectedVersion === undefined
          ? []
          : [
              statement<{ version: number }>(
                `SELECT version FROM memories
                 WHERE id = $1 AND workspace_id = $2
                 FOR UPDATE`,
                [id, storageScope.partitionId],
              ),
            ]),
      ],
      { commit: options.commit === true },
    );
    if (deleted.rows.length === 1) return true;
    const version = current?.rows[0]?.version;
    if (expectedVersion === undefined || version === undefined) return false;
    throw new MemoryVersionConflictError(expectedVersion, version);
  }

  /**
   * Delete a Memory this transaction locked (`lockMemoryInTransaction`), for a host
   * that must decide between the lock and the delete. Throws
   * MemoryVersionConflictError on a stale expected version. The locking read applied
   * the same write authority the delete policy does, so the delete removes the row;
   * it and the host's `finish` statements share one round trip.
   */
  async function forgetLockedMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    locked: LockedMemory,
    expectedVersion?: number,
    batchOptions: MemoryWriteBatchOptions = {},
  ): Promise<boolean> {
    if (expectedVersion !== undefined && locked.row.version !== expectedVersion) {
      throw new MemoryVersionConflictError(expectedVersion, locked.row.version);
    }
    const id = locked.row.id;
    const [deleted] = await transaction.batch(
      [
        statement<{ id: string }>(
          `DELETE FROM memories
           WHERE id = $1
             AND workspace_id = $2
           RETURNING id`,
          [id, storageScope.partitionId],
        ),
        ...(batchOptions.finish?.({ id, version: null }) ?? []),
      ],
      { commit: batchOptions.commit === true },
    );
    return deleted.rows.length === 1;
  }

  /**
   * Insert many Memories with caller-chosen ids in bounded set-based batches, with
   * their chunks and embedding jobs. Every record obeys the same content, scope, and
   * metadata rules as a single write. Returns each inserted id, in PostgreSQL's
   * lowercase form, with its version.
   */
  async function insertMemoriesInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    records: readonly InsertMemoryRecord[],
  ): Promise<{ memories: Array<{ id: string; version: number }> }> {
    const prepared = records.map((record, index) => ({
      // PostgreSQL returns uuid in lowercase; match RETURNING rows in that form.
      id: record.id.toLowerCase(),
      scope: validateMemoryScope(record.scope, `records[${index}].scope`),
      content: record.content,
      metadata: validateMemoryMetadata(record.metadata, `records[${index}].metadata`),
      chunks: batchRecordChunks(record, index),
    }));
    const inserted = await queryInRecordBatches<{ id: string; version: number | string }>(
      transaction,
      `INSERT INTO memories (
         id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata
       )
       SELECT record.id, $2::uuid, $3::uuid, $4::uuid, record.scope, record.content,
              record.metadata
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, scope memory_scope, content text, metadata jsonb
       )
       RETURNING id, version`,
      prepared.map(({ id, scope, content, metadata }) => ({ id, scope, content, metadata })),
      [storageScope.partitionId, storageScope.ownerId, storageScope.sourceId ?? null],
    );
    await queryInRecordBatches(
      transaction,
      `INSERT INTO memory_chunks (
         id, workspace_id, memory_id, ordinal, content, chunking_revision
       )
       SELECT gen_random_uuid(), $2::uuid, record.memory_id, record.ordinal, record.content,
              $3::text
       FROM jsonb_to_recordset($1::jsonb) AS record(
         memory_id uuid, ordinal integer, content text
       )`,
      prepared.flatMap(({ id, chunks }) =>
        chunks.map((content, ordinal) => ({ memory_id: id, ordinal, content })),
      ),
      [storageScope.partitionId, MEMORY_CHUNKING_REVISION],
    );
    // Jobs target the version each INSERT actually produced, not an assumed default.
    const versions = new Map(inserted.map((row) => [row.id, Number(row.version)] as const));
    const memories = prepared.map(({ id, scope }) => {
      const version = versions.get(id);
      if (version === undefined) throw new Error("A batch-inserted Memory returned no row");
      return { id, scope, version };
    });
    await enqueueEmbeddingJobsInTransaction(
      transaction,
      memories.map(({ id, scope, version }) => ({
        id,
        workspace_id: storageScope.partitionId,
        owner_user_id: storageScope.ownerId,
        scope,
        version,
      })),
    );
    return { memories: memories.map(({ id, version }) => ({ id, version })) };
  }

  return {
    enqueueEmbeddingJobsInTransaction,
    forgetLockedMemoryInTransaction,
    forgetMemoryInTransaction,
    insertMemoriesInTransaction,
    insertMemoryInTransaction,
    lockMemoryInTransaction,
    updateLockedMemoryInTransaction,
    updateMemoryInTransaction,
  };
}

export function createMemoryModule(
  storage: MemoryStorageContext,
  options: MemoryModuleOptions = {},
) {
  const { database } = storage;
  const storageScope: MemoryStorageScope = storage;
  const contextGroupExpansion = normalizeContextGroupExpansion(options.contextGroupExpansion);
  const embeddingProvider = options.embeddingProvider;
  const embeddingDimensions = configuredEmbeddingDimensions(options);
  const entityAliasRecall = options.entityAliasRecall ?? false;
  const evidenceNeighborChunks = Math.max(
    0,
    Math.min(Math.trunc(options.evidenceNeighborChunks ?? 0), 2),
  );
  const evidenceTopChunks = Math.max(1, Math.min(Math.trunc(options.evidenceTopChunks ?? 1), 5));
  const queryPlanningProvider = options.queryPlanningProvider;
  const queryPlannerMaxQueries = Math.max(1, Math.min(options.queryPlannerMaxQueries ?? 3, 5));
  const retrievalFeedbackQueries = Math.max(
    0,
    Math.min(Math.trunc(options.retrievalFeedbackQueries ?? 0), 3),
  );
  const retrievalRecencyWeight = Math.max(0, Math.min(options.retrievalRecencyWeight ?? 0, 1));
  const rerankingProvider = options.rerankingProvider;
  const rerankCandidateLimit = Math.max(1, Math.min(options.rerankCandidateLimit ?? 50, 200));
  const rerankDiversityLambda = Math.max(0, Math.min(options.rerankDiversityLambda ?? 1, 1));
  const rerankMinimumScore = Math.max(0, Math.min(options.rerankMinimumScore ?? 0, 1));
  const rerankWeight = Math.max(0, Math.min(options.rerankWeight ?? 1, 1));
  const semanticDistanceThreshold = Math.max(
    0,
    Math.min(options.semanticDistanceThreshold ?? 0.5, 2),
  );
  const { forgetMemoryInTransaction, insertMemoryInTransaction, updateMemoryInTransaction } =
    createMemoryMutationPrimitives(options);

  return {
    async remember(input: RememberMemory): Promise<Memory> {
      try {
        const created = await database.transaction((transaction) =>
          insertMemoryInTransaction(transaction, storageScope, input, undefined, { commit: true }),
        );
        return created.memory;
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new MemoryAccessDeniedError("Memory creation denied by the store", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async retrieve(id: string): Promise<Memory | null> {
      // One round trip: the read and COMMIT travel together with BEGIN and setup.
      const [result] = await database.transaction((transaction) =>
        transaction.batch(
          [
            statement<MemoryRow>(
              `SELECT ${memorySelectColumns()} FROM memories WHERE id = $1 AND workspace_id = $2`,
              [id, storageScope.partitionId],
            ),
          ],
          { commit: true },
        ),
      );
      return result.rows[0] ? memoryFromRow(result.rows[0]) : null;
    },

    async update(
      id: string,
      input: UpdateMemory,
      options: MemoryMutationOptions = {},
    ): Promise<Memory | null> {
      if (
        input.content === undefined &&
        input.scope === undefined &&
        input.metadata === undefined
      ) {
        return this.retrieve(id);
      }
      const updated = await database.transaction((transaction) =>
        updateMemoryInTransaction(transaction, storageScope, id, input, options.expectedVersion, {
          commit: true,
        }),
      );
      return updated?.memory ?? null;
    },

    async forget(id: string, options: MemoryMutationOptions = {}): Promise<boolean> {
      return database.transaction((transaction) =>
        forgetMemoryInTransaction(transaction, storageScope, id, {
          expectedVersion: options.expectedVersion,
          commit: true,
        }),
      );
    },

    async list(input: ListMemory = {}): Promise<Memory[]> {
      const limit = memoryListLimit(input.limit);
      const offset = memoryListOffset(input.offset);
      validateReadFilters(input);
      const [result] = await database.transaction((transaction) =>
        transaction.batch(
          [
            statement<MemoryRow>(
              // ORDER BY is qualified: a bare updated_at would name the text output
              // column, sorting strings instead of reading memories_workspace_updated_idx.
              `SELECT ${memorySelectColumns("memory")}
           FROM memories memory
           WHERE memory.workspace_id = $1
             AND ($4::memory_scope IS NULL OR memory.scope = $4::memory_scope)
             AND ($5::timestamptz IS NULL OR memory.updated_at >= $5::timestamptz)
             AND ($6::timestamptz IS NULL OR memory.updated_at < $6::timestamptz)
             AND ($7::jsonb IS NULL OR memory.metadata @> $7::jsonb)
             AND (
               $8::timestamptz IS NULL
               OR memory.updated_at < $8::timestamptz
               OR (
                 memory.updated_at = $8::timestamptz
                 AND memory.id > $9::uuid
               )
             )
           ORDER BY memory.updated_at DESC, memory.id
           LIMIT $2
           OFFSET $3`,
              [
                storageScope.partitionId,
                limit,
                offset,
                input.scope ?? null,
                input.updatedAfter ?? null,
                input.updatedBefore ?? null,
                input.metadataFilter ? JSON.stringify(input.metadataFilter) : null,
                input.cursor?.updatedAt ?? null,
                input.cursor?.id ?? null,
              ],
            ),
          ],
          { commit: true },
        ),
      );
      return result.rows.map(memoryFromRow);
    },

    async search(input: SearchMemory): Promise<MemorySearchResult[]> {
      const query = memorySearchQuery(input.query);
      const limit = memorySearchLimit(input.limit);
      validateReadFilters(input);
      if (!query) return [];
      const hasSecondStage =
        Boolean(rerankingProvider) || retrievalRecencyWeight > 0 || Boolean(contextGroupExpansion);
      const resultLimit = hasSecondStage ? Math.max(limit, rerankCandidateLimit) : limit;
      const candidateLimit = Math.min(resultLimit * 4, 800);
      const scope = input.scope ?? null;
      const updatedAfter = input.updatedAfter ?? null;
      const updatedBefore = input.updatedBefore ?? null;
      const metadataFilter = input.metadataFilter ?? null;
      let plannedQueries: string[] = [];
      if (queryPlanningProvider && queryPlannerMaxQueries > 1) {
        try {
          plannedQueries = await queryPlanningProvider.plan({
            query,
            maxQueries: queryPlannerMaxQueries - 1,
          });
        } catch {
          plannedQueries = [];
        }
      }
      const queries = retrievalQueries(query, plannedQueries, queryPlannerMaxQueries);
      const queryEmbeddings = await embedRetrievalQueries(
        embeddingProvider,
        queries,
        embeddingDimensions,
      );
      const queryStatements = queries.map((plannedQuery, index) =>
        searchStatement({
          storageScope,
          query: plannedQuery,
          queryEmbedding: queryEmbeddings[index] ?? null,
          embeddingDimensions,
          entityAliasRecall,
          candidateLimit,
          resultLimit,
          semanticDistanceThreshold,
          evidenceNeighborChunks,
          evidenceTopChunks,
          scope,
          updatedAfter,
          updatedBefore,
          metadataFilter,
          embeddingProvider,
        }),
      );
      // Every planned query is known up front, so they share one round trip. Without
      // context-group expansion COMMIT joins them; expansion reads the fused order,
      // which TypeScript decides, so it follows in the same transaction.
      let fusionResults: MemorySearchResult[] = await database.transaction(async (transaction) => {
        const resultSets = await transaction.batch(queryStatements, {
          commit: !contextGroupExpansion,
        });
        const fused = fuseQueryResults(
          resultSets.map((resultSet) => searchResults(resultSet.rows)),
          resultLimit,
        ) as InternalMemorySearchResult[];
        return contextGroupExpansion
          ? expandContextGroupResults({
              transaction,
              storageScope,
              results: fused,
              targetLimit: resultLimit,
              expansion: contextGroupExpansion,
              evidenceNeighborChunks,
              evidenceTopChunks,
              scope,
              updatedAfter,
              updatedBefore,
              metadataFilter,
            })
          : fused;
      });
      let feedbackSeedQuery = query;
      let feedbackSources = fusionResults;
      const feedbackSourceIds = new Set<string>();
      // The first pass stays fixed across rounds; every round's candidates join
      // one shared feedback reserve in discovery order, so a later round never
      // evicts an earlier round's bridge Memory.
      let firstPassResults = fusionResults;
      let feedbackPool: MemorySearchResult[] = [];
      for (let round = 0; round < retrievalFeedbackQueries; round += 1) {
        const feedback = feedbackRetrievalQuery(feedbackSeedQuery, feedbackSources);
        if (!feedback) break;
        feedbackSourceIds.add(feedback.excludedMemoryId);
        const [feedbackEmbedding] = await embedRetrievalQueries(
          embeddingProvider,
          [feedback.query],
          embeddingDimensions,
        );
        // The visibility check and the round's query are independent, so the round
        // is one round trip including COMMIT.
        const [stillVisible, feedbackRows] = await database.transaction((transaction) =>
          transaction.batch(
            [
              statement<{ id: string }>(
                `SELECT id
                 FROM memories
                 WHERE workspace_id = $1
                   AND id = ANY($2::uuid[])
                   AND ($3::memory_scope IS NULL OR scope = $3::memory_scope)
                   AND ($4::timestamptz IS NULL OR updated_at >= $4::timestamptz)
                   AND ($5::timestamptz IS NULL OR updated_at < $5::timestamptz)
                   AND ($6::jsonb IS NULL OR metadata @> $6::jsonb)`,
                [
                  storageScope.partitionId,
                  [...firstPassResults, ...feedbackPool].map((result) => result.memory.id),
                  scope,
                  updatedAfter,
                  updatedBefore,
                  metadataFilter ? JSON.stringify(metadataFilter) : null,
                ],
              ),
              searchStatement({
                storageScope,
                query: feedback.query,
                queryEmbedding: feedbackEmbedding ?? null,
                embeddingDimensions,
                entityAliasRecall,
                candidateLimit,
                resultLimit,
                semanticDistanceThreshold,
                evidenceNeighborChunks,
                evidenceTopChunks,
                scope,
                updatedAfter,
                updatedBefore,
                metadataFilter,
                excludedMemoryIds: [...feedbackSourceIds],
                embeddingProvider,
              }),
            ],
            { commit: true },
          ),
        );
        const feedbackRead = {
          results: searchResults(feedbackRows.rows),
          visibleMemoryIds: new Set(stillVisible.rows.map((row) => row.id)),
        };
        const isStillVisible = (result: MemorySearchResult) =>
          feedbackRead.visibleMemoryIds.has(result.memory.id);
        firstPassResults = firstPassResults.filter(isStillVisible);
        feedbackPool = [...feedbackPool.filter(isStillVisible), ...feedbackRead.results];
        fusionResults = appendFeedbackResults(firstPassResults, feedbackPool, resultLimit);
        if (!feedbackRead.results.length) break;
        feedbackSeedQuery = feedback.query;
        feedbackSources = feedbackRead.results;
      }
      fusionResults = fuseRecencyResults(fusionResults, retrievalRecencyWeight);
      if (!rerankingProvider || fusionResults.length === 0) {
        return fusionResults.slice(0, limit);
      }
      try {
        const reranked = await rerankingProvider.rerank({
          query,
          documents: fusionResults.map((result) => ({
            id: result.memory.id,
            text: compactRerankEvidence(result),
          })),
          limit: fusionResults.length,
        });
        const resultById = new Map(
          fusionResults.map((result) => [result.memory.id, result] as const),
        );
        const seen = new Set<string>();
        const results = reranked.map((rerankResult) => {
          const result = resultById.get(rerankResult.documentId);
          if (
            !result ||
            seen.has(rerankResult.documentId) ||
            !Number.isFinite(rerankResult.score) ||
            rerankResult.score < 0 ||
            rerankResult.score > 1
          ) {
            throw new Error("Reranking provider returned an invalid result");
          }
          seen.add(rerankResult.documentId);
          return { ...result, score: rerankResult.score, rerankScore: rerankResult.score };
        });
        if (results.length !== fusionResults.length) {
          throw new Error("Reranking provider returned the wrong number of results");
        }
        // Rank by the validated scores, not the provider's array order. The sort
        // is stable, so equal scores keep the provider's order and an already
        // sorted response is unchanged.
        results.sort((left, right) => right.rerankScore - left.rerankScore);
        return diversifyRerankedResults(
          fuseRerankedResults(
            fusionResults,
            results.filter((result) => result.rerankScore >= rerankMinimumScore),
            rerankWeight,
          ),
          limit,
          rerankDiversityLambda,
        );
      } catch {
        return fusionResults.slice(0, limit);
      }
    },
  };
}

import { type EmbeddingProvider, validatedEmbeddingDimensions } from "./capabilities";
import type { MemoryStorageContext, MemoryStorageScope, PostgresTransaction } from "./db";
import { isPostgresAccessDenied } from "./db";
import { MEMORY_CHUNKING_REVISION } from "./memory-chunking";
import { prepareMemoryContent } from "./memory-content";
import type {
  ContextGroupExpansionOptions,
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
import { RETRIEVAL_CONTEXT_GROUP_POLICY } from "./retrieval/policy";
import {
  cjkLexicalGrams,
  feedbackRetrievalQueries,
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
  timestampMilliseconds,
} from "./retrieval/ranking";
import { embeddingVectorLiteral } from "./vector";

export type * from "./memory-types";
export * from "./retrieval/policy";

export class MemoryAccessDeniedError extends Error {
  override name = "MemoryAccessDeniedError";
}

export class MemoryVersionConflictError extends Error {
  override name = "MemoryVersionConflictError";
  readonly status = 412;

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

interface PreparedChunk {
  content: string;
}

function prepareChunks(content: string): PreparedChunk[] {
  return prepareMemoryContent(content).chunks.map((chunk) => ({ content: chunk }));
}

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
      timestamp: timestampMilliseconds(result.memory.updatedAt),
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
  const expanded = await input.transaction.query<SearchRow>(
    `SELECT
       ${memorySelectColumns("memory")},
       0::double precision AS score,
       evidence.content AS evidence,
       evidence.content AS rerank_evidence
     FROM memories memory
     JOIN LATERAL (
       SELECT string_agg(selected.content, '' ORDER BY selected.ordinal) AS content
       FROM (
         SELECT chunk.content, chunk.ordinal
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
    ],
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
      const timestamp = timestampMilliseconds(result.memory.updatedAt);
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
 * Normalize a driver-returned timestamp (Date, ISO string, or Postgres text)
 * to a UTC ISO-8601 string. Exported for host extensions that map their own
 * row shapes (for example lore's Memory Proposals module).
 */
export function serializedTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * The canonical Memory timestamp: RFC 3339 UTC text with the column's full
 * microsecond precision, for example `2026-01-02T03:04:05.123456Z`. A driver
 * `Date` keeps only milliseconds, so a Memory serialized from one would not
 * match the same row's list cursor, and a millisecond cursor would skip rows
 * that share a millisecond. The fixed-width text sorts chronologically and
 * round-trips through `::timestamptz` exactly.
 */
function memoryTimestampSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
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
    `${memoryTimestampSql(column("created_at"))} AS created_at`,
    `${memoryTimestampSql(column("updated_at"))} AS updated_at`,
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

async function searchOneQuery(input: {
  transaction: PostgresTransaction;
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
}): Promise<MemorySearchResult[]> {
  const result = await input.transaction.query<SearchRow>(
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
       LIMIT 8
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
  return result.rows.map((row) => ({
    memory: memoryFromRow(row),
    score: Number(row.score),
    evidence: row.evidence,
    [rerankEvidence]: row.rerank_evidence,
  }));
}

async function insertChunks(
  transaction: PostgresTransaction,
  workspaceId: string,
  memoryId: string,
  chunks: PreparedChunk[],
): Promise<void> {
  if (chunks.length === 0) return;
  // One round trip while the caller holds the Memory row lock. Ordinals follow
  // the prepared chunk order. Vectors live in generation-scoped
  // memory_chunk_embeddings, so no per-chunk embedding columns are written.
  await transaction.query(
    `INSERT INTO memory_chunks (
       id, workspace_id, memory_id, ordinal, content, chunking_revision
     )
     SELECT chunk.id, $1::uuid, $2::uuid, (chunk.position - 1)::integer, chunk.content, $5
     FROM unnest($3::uuid[], $4::text[]) WITH ORDINALITY AS chunk(id, content, position)`,
    [
      workspaceId,
      memoryId,
      chunks.map(() => crypto.randomUUID()),
      chunks.map((chunk) => chunk.content),
      MEMORY_CHUNKING_REVISION,
    ],
  );
}

async function enqueueEmbeddingJob(
  transaction: PostgresTransaction,
  memory: MemoryRow,
  embeddingProvider: EmbeddingProvider,
  onlyWhenStale = false,
): Promise<string | null> {
  const generation = await transaction.query<{ id: string }>(
    `SELECT id
     FROM lore.ensure_embedding_generation($1, $2, $3, $4)`,
    [
      embeddingProvider.provider,
      embeddingProvider.model,
      embeddingProvider.dimensions,
      embeddingProvider.revision,
    ],
  );
  const generationId = generation.rows[0]?.id;
  if (!generationId) throw new Error("Embedding generation could not be resolved");
  const jobId = crypto.randomUUID();
  const inserted = await transaction.query<{ inserted: boolean }>(
    `INSERT INTO memory_embedding_jobs (
       id, workspace_id, memory_id, owner_user_id, memory_scope,
       memory_version, embedding_provider, embedding_model, embedding_revision,
       generation_id
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $11
     WHERE NOT $10::boolean
        OR EXISTS (
          SELECT 1
          FROM memory_chunks chunk
          WHERE chunk.workspace_id = $2
            AND chunk.memory_id = $3
            AND NOT EXISTS (
              SELECT 1
              FROM memory_chunk_embeddings embedded
              WHERE embedded.generation_id = $11
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
      generationId,
    ],
  );
  // The request role deliberately holds INSERT but not SELECT on this private
  // table. A RETURNING list that names no column needs no SELECT privilege and
  // applies no SELECT policy, so it reports exactly the row this INSERT wrote
  // without reading the table. Return the id only for an inserted job: a stale
  // check that inserted nothing yields null, and every non-null id is a real
  // job worth a maintenance notification.
  return inserted.rows.length > 0 ? jobId : null;
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

export interface MemoryMutationPrimitivesOptions {
  defaultMemoryScope?: MemoryScope;
  embeddingProvider?: EmbeddingProvider;
  maintenanceNotifier?: MemoryMaintenanceNotifier;
}

/**
 * Transaction-scoped Memory write primitives shared by the Memory module and
 * host extensions that create or update canonical Memories inside their own
 * transactions (lore's Memory Proposals review is the canonical example).
 * Callers own the surrounding transaction, storage access policy,
 * authorization checks, and idempotency bookkeeping.
 */
export function createMemoryMutationPrimitives(options: MemoryMutationPrimitivesOptions = {}) {
  const defaultMemoryScope = options.defaultMemoryScope ?? "shared";
  const embeddingProvider = options.embeddingProvider;
  const maintenanceNotifier = options.maintenanceNotifier;

  function notifyMaintenance(jobId: string | null): void {
    if (!jobId || !maintenanceNotifier) return;
    try {
      maintenanceNotifier.notify({ jobId });
    } catch {
      // The durable Postgres job remains discoverable by the maintenance sweep.
      // A queue notification is only a latency optimization.
    }
  }

  async function insertMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    input: RememberMemory,
    createdByAgentId: string | null = storageScope.sourceId ?? null,
  ): Promise<{ jobId: string | null; memory: Memory }> {
    const chunks = prepareChunks(input.content);
    const id = crypto.randomUUID();
    const result = await transaction.query<MemoryRow>(
      `INSERT INTO memories (
         id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING ${memorySelectColumns()}`,
      [
        id,
        storageScope.partitionId,
        storageScope.ownerId,
        createdByAgentId,
        input.scope ?? defaultMemoryScope,
        input.content,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const memory = result.rows[0];
    if (!memory) throw new Error("Memory insert returned no row");
    await insertChunks(transaction, storageScope.partitionId, id, chunks);
    const jobId = embeddingProvider
      ? await enqueueEmbeddingJob(transaction, memory, embeddingProvider)
      : null;
    return { memory: memoryFromRow(memory), jobId };
  }

  async function updateMemoryInTransaction(
    transaction: PostgresTransaction,
    storageScope: MemoryStorageScope,
    id: string,
    input: UpdateMemory,
    expectedVersion?: number,
  ): Promise<{ chunksChanged: boolean; jobId: string | null; memory: Memory } | null> {
    const current = await transaction.query<MemoryRow>(
      `SELECT *
       FROM memories
       WHERE id = $1
         AND workspace_id = $2
       FOR UPDATE`,
      [id, storageScope.partitionId],
    );
    const currentMemory = current.rows[0];
    if (!currentMemory) return null;
    if (expectedVersion !== undefined && currentMemory.version !== expectedVersion) {
      throw new MemoryVersionConflictError(expectedVersion, currentMemory.version);
    }
    const contentToEmbed =
      input.content ?? (input.scope === undefined ? null : currentMemory.content);
    const chunks = contentToEmbed === null ? null : prepareChunks(contentToEmbed);
    const result = await transaction.query<MemoryRow>(
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
        input.content ?? null,
        input.scope ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        currentMemory.version,
      ],
    );
    const updated = result.rows[0];
    if (!updated) {
      return null;
    }
    if (chunks) {
      await transaction.query(
        "DELETE FROM memory_chunks WHERE workspace_id = $1 AND memory_id = $2",
        [storageScope.partitionId, id],
      );
      await insertChunks(transaction, storageScope.partitionId, id, chunks);
    }
    const jobId = embeddingProvider
      ? await enqueueEmbeddingJob(transaction, updated, embeddingProvider, chunks === null)
      : null;
    return { memory: memoryFromRow(updated), jobId, chunksChanged: chunks !== null };
  }

  return { insertMemoryInTransaction, notifyMaintenance, updateMemoryInTransaction };
}

export function createMemoryModule(
  storage: MemoryStorageContext,
  options: MemoryModuleOptions = {},
) {
  const { database } = storage;
  const storageScope: MemoryStorageScope = storage;
  const contextGroupExpansion = normalizeContextGroupExpansion(options.contextGroupExpansion);
  const embeddingProvider = options.embeddingProvider;
  const embeddingDimensions = validatedEmbeddingDimensions(
    options.embeddingDimensions ?? embeddingProvider?.dimensions ?? 1024,
  );
  if (embeddingProvider && embeddingProvider.dimensions !== embeddingDimensions) {
    throw new Error(
      "embeddingDimensions must match embeddingProvider.dimensions: " +
        `the module is configured for ${embeddingDimensions} but the provider embeds at ${embeddingProvider.dimensions}`,
    );
  }
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
  const { insertMemoryInTransaction, notifyMaintenance, updateMemoryInTransaction } =
    createMemoryMutationPrimitives(options);

  return {
    async remember(input: RememberMemory): Promise<Memory> {
      try {
        const created = await database.transaction((transaction) =>
          insertMemoryInTransaction(transaction, storageScope, input),
        );
        notifyMaintenance(created.jobId);
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
      return database.transaction(async (transaction) => {
        const result = await transaction.query<MemoryRow>(
          `SELECT ${memorySelectColumns()} FROM memories WHERE id = $1 AND workspace_id = $2`,
          [id, storageScope.partitionId],
        );
        return result.rows[0] ? memoryFromRow(result.rows[0]) : null;
      });
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
        updateMemoryInTransaction(transaction, storageScope, id, input, options.expectedVersion),
      );
      // A job id is non-null only when this update inserted a job, including a
      // metadata-only update whose chunks still lack current-generation vectors.
      notifyMaintenance(updated?.jobId ?? null);
      return updated?.memory ?? null;
    },

    async forget(id: string, options: MemoryMutationOptions = {}): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const current = await transaction.query<{ version: number }>(
          `SELECT version FROM memories
           WHERE id = $1 AND workspace_id = $2
           FOR UPDATE`,
          [id, storageScope.partitionId],
        );
        const version = current.rows[0]?.version;
        if (version === undefined) return false;
        if (options.expectedVersion !== undefined && version !== options.expectedVersion) {
          throw new MemoryVersionConflictError(options.expectedVersion, version);
        }
        const result = await transaction.query<{ id: string }>(
          `DELETE FROM memories WHERE id = $1 AND workspace_id = $2 AND version = $3 RETURNING id`,
          [id, storageScope.partitionId, version],
        );
        return result.rows.length === 1;
      });
    },

    async list(input: ListMemory = {}): Promise<Memory[]> {
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      const offset = Math.max(0, Math.min(input.offset ?? 0, 1_000_000));
      return database.transaction(async (transaction) => {
        const result = await transaction.query<MemoryRow>(
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
        );
        return result.rows.map(memoryFromRow);
      });
    },

    async search(input: SearchMemory): Promise<MemorySearchResult[]> {
      const query = input.query.trim();
      if (!query) return [];
      const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
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
      let fusionResults: MemorySearchResult[] = await database.transaction(async (transaction) => {
        const resultSets: MemorySearchResult[][] = [];
        for (const [index, plannedQuery] of queries.entries()) {
          resultSets.push(
            await searchOneQuery({
              transaction,
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
        }
        const fused = fuseQueryResults(resultSets, resultLimit) as InternalMemorySearchResult[];
        return contextGroupExpansion
          ? expandContextGroupResults({
              transaction,
              storageScope,
              results: fused,
              targetLimit: resultLimit,
              expansion: contextGroupExpansion,
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
        const feedback = feedbackRetrievalQueries(feedbackSeedQuery, feedbackSources, 1)[0];
        if (!feedback) break;
        feedbackSourceIds.add(feedback.excludedMemoryId);
        const [feedbackEmbedding] = await embedRetrievalQueries(
          embeddingProvider,
          [feedback.query],
          embeddingDimensions,
        );
        const feedbackRead = await database.transaction(async (transaction) => {
          const stillVisible = await transaction.query<{ id: string }>(
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
          );
          const results = await searchOneQuery({
            transaction,
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
          });
          return {
            results,
            visibleMemoryIds: new Set(stillVisible.rows.map((row) => row.id)),
          };
        });
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
            results.filter((result) => (result.rerankScore ?? result.score) >= rerankMinimumScore),
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

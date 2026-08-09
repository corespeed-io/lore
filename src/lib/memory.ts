import { type ActorContext, installActorContext } from "./actor-context";
import { isPostgresAccessDenied } from "./database-errors";
import type { PostgresDatabase, PostgresTransaction } from "./db";
import { embeddingVectorLiteral } from "./embedding/vector";
import type { EmbeddingDimensions } from "./embedding-config";
import { beginMutation, completeMutation, type IdempotencyRequest } from "./idempotency";
import { chunkMemoryContent } from "./memory-chunking";
import type { QueryPlanningProvider } from "./query-planning";
import type { RerankingProvider } from "./reranking";

export type { ActorContext } from "./actor-context";

export type MemoryScope = "shared" | "private";

export const RETRIEVAL_FEEDBACK_CANDIDATE_POLICY = {
  revision: "iterative-tail-reserve-v2",
  targetShare: 0.2,
  minimumSlots: 1,
} as const;

export const RETRIEVAL_EVIDENCE_POLICY = {
  revision: "compact-rerank-expanded-answer-v1",
  rerankPassage: "best-chunk-with-configured-neighbors",
  answerEvidence: "bounded-top-chunks-with-whole-small-memory",
} as const;

export const RETRIEVAL_ENTITY_ALIAS_POLICY = {
  revision: "deterministic-exact-alias-rrf-v1",
  candidateGeneration: "independent-rls-filtered-chunk-channel",
  maximumQueryAliases: 8,
  reference: {
    title: "Multi-step Entity-centric Information Retrieval for Multi-Hop Question Answering",
    doi: "https://doi.org/10.18653/v1/D19-5816",
  },
} as const;

export const RETRIEVAL_CONTEXT_GROUP_POLICY = {
  revision: "explicit-natural-boundary-append-v2",
  defaultBaseCandidateLimit: 20,
  defaultMaximumGroups: 3,
  maximumFetchedMemories: 800,
  provenance: {
    relationship: "Lore adaptation using only caller-supplied source structure",
    title: "HiGMem: Hierarchical Memory for Long-Term Conversational Agents",
    paper: "https://aclanthology.org/2026.findings-acl.1690/",
  },
} as const;

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

export interface Memory {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  createdByAgentId: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RememberMemory {
  content: string;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface UpdateMemory {
  content?: string;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface MemoryMutationOptions {
  expectedVersion?: number;
  idempotency?: IdempotencyRequest;
}

export interface SearchMemory {
  query: string;
  limit?: number;
  metadataFilter?: Record<string, unknown>;
  scope?: MemoryScope;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface ListMemory {
  cursor?: { id: string; updatedAt: string };
  limit?: number;
  offset?: number;
  metadataFilter?: Record<string, unknown>;
  scope?: MemoryScope;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
  rerankScore?: number;
  evidence: string;
}

export interface EmbeddingProvider {
  provider: string;
  model: string;
  dimensions: EmbeddingDimensions;
  revision: string;
  embed(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

export type EmbeddingTask = "document" | "query";

export interface MemoryModuleOptions {
  contextGroupExpansion?: ContextGroupExpansionOptions;
  embeddingProvider?: EmbeddingProvider;
  entityAliasRecall?: boolean;
  evidenceNeighborChunks?: number;
  evidenceTopChunks?: number;
  maintenanceNotifier?: MemoryMaintenanceNotifier;
  queryPlanningProvider?: QueryPlanningProvider;
  queryPlannerMaxQueries?: number;
  retrievalFeedbackQueries?: number;
  retrievalRecencyWeight?: number;
  rerankingProvider?: RerankingProvider;
  rerankCandidateLimit?: number;
  rerankDiversityLambda?: number;
  rerankMinimumScore?: number;
  rerankWeight?: number;
  semanticDistanceThreshold?: number;
}

export interface ContextGroupExpansionOptions {
  /** Metadata scalar that identifies an explicit source session/topic/thread. */
  groupMetadataKey: string;
  /** Optional numeric metadata scalar used to prefer nearby members within a group. */
  ordinalMetadataKey?: string;
  /** Ordinary ranked candidates preserved before structural candidates are appended. */
  baseCandidateLimit?: number;
  /** Maximum distinct groups seeded from the preserved ranked candidates. */
  maximumGroups?: number;
}

export interface MemoryEmbeddingJobMessage {
  jobId: string;
}

export interface MemoryMaintenanceNotifier {
  notify(message: MemoryEmbeddingJobMessage): void;
}

interface MemoryRow {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  created_by_agent_id: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

interface SearchRow extends MemoryRow {
  score: number;
  evidence: string;
  rerank_evidence: string;
}

const rerankEvidence = Symbol("lore.rerankEvidence");

type InternalMemorySearchResult = MemorySearchResult & {
  [rerankEvidence]: string;
};

function compactRerankEvidence(result: MemorySearchResult): string {
  return (result as Partial<InternalMemorySearchResult>)[rerankEvidence] ?? result.evidence;
}

interface PreparedChunk {
  content: string;
}

function prepareChunks(content: string): PreparedChunk[] {
  return chunkMemoryContent(content).map((chunk) => ({ content: chunk }));
}

function relaxedEnglishTerms(query: string): string[] {
  const terms = query.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    const key = term.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(term);
  }
  return unique.slice(0, 32);
}

function evidenceTerms(text: string): Set<string> {
  return new Set(
    (text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [])
      .map((term) => term.toLocaleLowerCase())
      .filter((term) => term.length > 1),
  );
}

const feedbackStopWords = new Set([
  "about",
  "after",
  "also",
  "before",
  "does",
  "from",
  "have",
  "into",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function feedbackEvidenceExcerpt(original: string, evidence: string): string {
  const queryTerms = [...evidenceTerms(original)].filter(
    (term) => term.length > 2 && !feedbackStopWords.has(term),
  );
  const passages =
    evidence.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu)?.map((passage) => passage.trim()) ?? [];
  if (!passages.length || !queryTerms.length) return evidence.slice(0, 1_000);

  let bestPassage = passages[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [index, passage] of passages.entries()) {
    const terms = evidenceTerms(passage);
    const score = queryTerms.reduce(
      (total, term) => total + (terms.has(term) ? Math.min(term.length, 12) : 0),
      0,
    );
    const normalizedLength = Math.max(1, Math.min(passage.length, 500));
    const objective = score / Math.sqrt(normalizedLength) - index / 1_000_000;
    if (objective > bestScore) {
      bestPassage = passage;
      bestScore = objective;
    }
  }
  return (bestScore > 0 ? bestPassage : evidence).slice(0, 1_000);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function diversifyRerankedResults(
  results: MemorySearchResult[],
  limit: number,
  lambda: number,
): MemorySearchResult[] {
  if (lambda >= 1 || results.length <= 1) return results.slice(0, limit);
  const remaining = results.map((result, index) => ({
    result,
    index,
    terms: evidenceTerms(result.evidence),
  }));
  const selected: typeof remaining = [];
  while (selected.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestObjective = Number.NEGATIVE_INFINITY;
    for (const [index, candidate] of remaining.entries()) {
      const maximumSimilarity = selected.length
        ? Math.max(...selected.map((item) => jaccard(candidate.terms, item.terms)))
        : 0;
      const relevance = (results.length - candidate.index) / results.length;
      const objective = lambda * relevance - (1 - lambda) * maximumSimilarity;
      if (
        objective > bestObjective ||
        (objective === bestObjective && candidate.index < remaining[bestIndex].index)
      ) {
        bestObjective = objective;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected.map((item) => item.result);
}

function fuseRerankedResults(
  fusionResults: MemorySearchResult[],
  rerankedResults: MemorySearchResult[],
  weight: number,
): MemorySearchResult[] {
  if (weight >= 1) return rerankedResults;
  const fusionRankById = new Map(
    fusionResults.map((result, index) => [result.memory.id, index + 1] as const),
  );
  return rerankedResults
    .map((result, index) => {
      const rerankRank = index + 1;
      const fusionRank = fusionRankById.get(result.memory.id);
      if (fusionRank === undefined) throw new Error("Reranking result escaped the candidate pool");
      return {
        ...result,
        score: weight / (60 + rerankRank) + (1 - weight) / (60 + fusionRank),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (fusionRankById.get(left.memory.id) ?? 0) - (fusionRankById.get(right.memory.id) ?? 0),
    );
}

function fuseQueryResults(resultSets: MemorySearchResult[][], limit: number): MemorySearchResult[] {
  if (resultSets.length === 1) return resultSets[0].slice(0, limit);
  const fused = new Map<
    string,
    { result: MemorySearchResult; score: number; bestRank: number; firstQuery: number }
  >();
  for (const [queryIndex, results] of resultSets.entries()) {
    for (const [resultIndex, result] of results.entries()) {
      const rank = resultIndex + 1;
      const existing = fused.get(result.memory.id);
      const score = 1 / (60 + rank);
      if (!existing) {
        fused.set(result.memory.id, {
          result,
          score,
          bestRank: rank,
          firstQuery: queryIndex,
        });
        continue;
      }
      existing.score += score;
      if (rank < existing.bestRank) {
        existing.result = result;
        existing.bestRank = rank;
        existing.firstQuery = queryIndex;
      }
    }
  }
  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.bestRank - right.bestRank ||
        left.firstQuery - right.firstQuery ||
        left.result.memory.id.localeCompare(right.result.memory.id),
    )
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score }));
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
  actor: ActorContext;
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
       memory.id,
       memory.workspace_id,
       memory.owner_user_id,
       memory.created_by_agent_id,
       memory.scope,
       memory.content,
       memory.metadata,
       memory.version,
       memory.created_at,
       memory.updated_at,
       0::double precision AS score,
       evidence.content AS evidence,
       evidence.content AS rerank_evidence
     FROM memories memory
     JOIN LATERAL (
       SELECT string_agg(selected.content, E'\\n' ORDER BY selected.ordinal) AS content
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
      input.actor.workspaceId,
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
        memory: toMemory(row),
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

function appendFeedbackResults(
  initialResults: MemorySearchResult[],
  feedbackResults: MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  const initial = initialResults.slice(0, limit);
  if (limit <= 1) return initial;
  const initialIds = new Set(initial.map((result) => result.memory.id));
  const novelFeedback = feedbackResults.filter((result) => !initialIds.has(result.memory.id));
  if (!novelFeedback.length) return initial;

  const reservedFeedbackSlots = Math.min(
    novelFeedback.length,
    Math.max(
      RETRIEVAL_FEEDBACK_CANDIDATE_POLICY.minimumSlots,
      Math.floor(limit * RETRIEVAL_FEEDBACK_CANDIDATE_POLICY.targetShare),
    ),
  );
  const feedbackSlots = Math.min(
    novelFeedback.length,
    Math.max(limit - initial.length, reservedFeedbackSlots),
  );
  return [...initial.slice(0, limit - feedbackSlots), ...novelFeedback.slice(0, feedbackSlots)];
}

function timestampMilliseconds(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value));
}

function serializedTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function fuseRecencyResults(results: MemorySearchResult[], weight: number): MemorySearchResult[] {
  if (weight <= 0 || results.length <= 1) return results;
  const relevanceRankById = new Map(
    results.map((result, index) => [result.memory.id, index + 1] as const),
  );
  const recencyRankById = new Map(
    [...results]
      .sort(
        (left, right) =>
          timestampMilliseconds(right.memory.updatedAt) -
            timestampMilliseconds(left.memory.updatedAt) ||
          left.memory.id.localeCompare(right.memory.id),
      )
      .map((result, index) => [result.memory.id, index + 1] as const),
  );
  return results
    .map((result) => {
      const relevanceRank = relevanceRankById.get(result.memory.id) ?? results.length;
      const recencyRank = recencyRankById.get(result.memory.id) ?? results.length;
      return {
        ...result,
        score: (1 - weight) / (60 + relevanceRank) + weight / (60 + recencyRank),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (relevanceRankById.get(left.memory.id) ?? 0) -
          (relevanceRankById.get(right.memory.id) ?? 0),
    );
}

function retrievalQueries(original: string, planned: string[], maximum: number): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const query of [original, ...planned]) {
    const normalized = query.trim().replace(/\s+/g, " ").slice(0, 2_000);
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    queries.push(normalized);
    if (queries.length >= maximum) break;
  }
  return queries;
}

function feedbackRetrievalQueries(
  original: string,
  results: MemorySearchResult[],
  maximum: number,
): Array<{ query: string; excludedMemoryId: string }> {
  if (maximum <= 0) return [];
  const originalTerms = evidenceTerms(original);
  const queries: Array<{ query: string; excludedMemoryId: string }> = [];
  const seen = new Set<string>();
  for (const result of results) {
    const evidence = result.evidence.trim();
    if (!evidence) continue;
    const excerpt = feedbackEvidenceExcerpt(original, evidence);
    const hasNovelTerm = [...evidenceTerms(excerpt)].some(
      (term) => term.length > 2 && !feedbackStopWords.has(term) && !originalTerms.has(term),
    );
    if (!hasNovelTerm) continue;
    const query = `${original.slice(0, 1_000)}\n${excerpt}`.trim().replace(/\s+/g, " ");
    const key = query.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ query, excludedMemoryId: result.memory.id });
    if (queries.length >= maximum) break;
  }
  return queries;
}

async function embedRetrievalQueries(
  embeddingProvider: EmbeddingProvider | undefined,
  queries: string[],
): Promise<Array<string | null>> {
  const embeddings: Array<string | null> = queries.map(() => null);
  if (!embeddingProvider || queries.length === 0) return embeddings;
  try {
    const vectors = await embeddingProvider.embed(queries, "query");
    if (vectors.length !== queries.length) {
      throw new Error("Embedding provider returned the wrong number of query vectors");
    }
    for (const [index, vector] of vectors.entries()) {
      embeddings[index] = embeddingVectorLiteral(vector);
    }
  } catch {
    embeddings.fill(null);
  }
  return embeddings;
}

async function searchOneQuery(input: {
  transaction: PostgresTransaction;
  actor: ActorContext;
  query: string;
  queryEmbedding: string | null;
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
  embeddingProvider?: EmbeddingProvider;
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
     lexical_candidates AS (
       SELECT * FROM simple_lexical_candidates
       UNION ALL
       SELECT * FROM english_lexical_candidates
       UNION ALL
       SELECT * FROM relaxed_english_lexical_candidates
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
         AND generation.embedding_dimensions = 1024
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
           ORDER BY chunk.embedding <=> $3::vector(1024),
                    chunk.memory_updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM active_semantic_chunks chunk
       WHERE (chunk.embedding <=> $3::vector(1024)) <= $5
       ORDER BY chunk.embedding <=> $3::vector(1024),
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
       memory.id,
       memory.workspace_id,
       memory.owner_user_id,
       memory.created_by_agent_id,
       memory.scope,
       memory.content,
       memory.metadata,
       memory.version,
       memory.created_at,
       memory.updated_at,
       ranked_memories.score,
       evidence.content AS evidence,
       rerank_evidence.content AS rerank_evidence
     FROM ranked_memories
     JOIN memories memory
       ON memory.id = ranked_memories.memory_id
      AND memory.workspace_id = $2
     JOIN LATERAL (
       SELECT string_agg(selected.content, E'\n' ORDER BY selected.ordinal) AS content
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
       SELECT string_agg(selected.content, E'\n' ORDER BY selected.ordinal) AS content
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
      input.actor.workspaceId,
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
    ],
  );
  return result.rows.map((row) => ({
    memory: toMemory(row),
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
  for (const [ordinal, chunk] of chunks.entries()) {
    await transaction.query(
      `INSERT INTO memory_chunks (
         id, workspace_id, memory_id, ordinal, content, embedding,
         embedding_provider, embedding_model, embedding_revision, embedded_at
       ) VALUES (
         $1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, NULL
       )`,
      [crypto.randomUUID(), workspaceId, memoryId, ordinal, chunk.content],
    );
  }
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
  await transaction.query(
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
    `,
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
  // The request role deliberately cannot SELECT this private table, so callers
  // use the allocated id only when the write guarantees that a job was inserted.
  return jobId;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    createdByAgentId: row.created_by_agent_id,
    scope: row.scope,
    content: row.content,
    metadata: row.metadata,
    version: row.version,
    createdAt: serializedTimestamp(row.created_at),
    updatedAt: serializedTimestamp(row.updated_at),
  };
}

export function createMemoryModule(database: PostgresDatabase, options: MemoryModuleOptions = {}) {
  const contextGroupExpansion = normalizeContextGroupExpansion(options.contextGroupExpansion);
  const embeddingProvider = options.embeddingProvider;
  const entityAliasRecall = options.entityAliasRecall ?? false;
  const evidenceNeighborChunks = Math.max(
    0,
    Math.min(Math.trunc(options.evidenceNeighborChunks ?? 0), 2),
  );
  const evidenceTopChunks = Math.max(1, Math.min(Math.trunc(options.evidenceTopChunks ?? 1), 5));
  const maintenanceNotifier = options.maintenanceNotifier;
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

  function notifyMaintenance(jobId: string | null): void {
    if (!jobId || !maintenanceNotifier) return;
    try {
      maintenanceNotifier.notify({ jobId });
    } catch {
      // The durable Postgres job remains discoverable by the maintenance sweep.
      // A queue notification is only a latency optimization.
    }
  }

  return {
    async remember(
      actor: ActorContext,
      input: RememberMemory,
      options: MemoryMutationOptions = {},
    ): Promise<Memory> {
      try {
        const chunks = prepareChunks(input.content);
        const created = await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const claim = await beginMutation<{ memory: Memory }>(
            transaction,
            actor,
            options.idempotency,
          );
          if (claim.replay) {
            return { memory: claim.replay.body.memory, jobId: null, replayed: true };
          }
          const access = await transaction.query<{ allowed: boolean }>(
            "SELECT lore.can_write_memory($1, $2) AS allowed",
            [actor.workspaceId, actor.userId],
          );
          if (access.rows[0]?.allowed !== true) {
            throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace");
          }
          const id = crypto.randomUUID();
          const result = await transaction.query<MemoryRow>(
            `INSERT INTO memories (
               id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
             RETURNING *`,
            [
              id,
              actor.workspaceId,
              actor.userId,
              actor.agentId ?? null,
              input.scope ?? "shared",
              input.content,
              JSON.stringify(input.metadata ?? {}),
            ],
          );
          const memory = result.rows[0];
          await insertChunks(transaction, actor.workspaceId, id, chunks);
          const jobId = embeddingProvider
            ? await enqueueEmbeddingJob(transaction, memory, embeddingProvider)
            : null;
          const createdMemory = toMemory(memory);
          await completeMutation(
            transaction,
            claim.requestId,
            201,
            { memory: createdMemory },
            Boolean(options.idempotency),
          );
          return { memory: createdMemory, jobId, replayed: false };
        });
        if (!created.replayed) notifyMaintenance(created.jobId);
        return created.memory;
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async retrieve(actor: ActorContext, id: string): Promise<Memory | null> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<MemoryRow>(
          "SELECT * FROM memories WHERE id = $1 AND workspace_id = $2",
          [id, actor.workspaceId],
        );
        return result.rows[0] ? toMemory(result.rows[0]) : null;
      });
    },

    async update(
      actor: ActorContext,
      id: string,
      input: UpdateMemory,
      options: MemoryMutationOptions = {},
    ): Promise<Memory | null> {
      if (
        input.content === undefined &&
        input.scope === undefined &&
        input.metadata === undefined
      ) {
        return this.retrieve(actor, id);
      }
      const updatedResult = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const claim = await beginMutation<{ memory: Memory | null }>(
          transaction,
          actor,
          options.idempotency,
        );
        if (claim.replay) {
          return { memory: claim.replay.body.memory, jobId: null, chunksChanged: false };
        }
        const current = await transaction.query<MemoryRow>(
          `SELECT *
           FROM memories
           WHERE id = $1
             AND workspace_id = $2
             AND lore.can_write_memory(workspace_id, owner_user_id)
           FOR UPDATE`,
          [id, actor.workspaceId],
        );
        const currentMemory = current.rows[0];
        if (!currentMemory) {
          await completeMutation(
            transaction,
            claim.requestId,
            404,
            { memory: null },
            Boolean(options.idempotency),
          );
          return { memory: null, jobId: null, chunksChanged: false };
        }
        if (
          options.expectedVersion !== undefined &&
          currentMemory.version !== options.expectedVersion
        ) {
          throw new MemoryVersionConflictError(options.expectedVersion, currentMemory.version);
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
           RETURNING *`,
          [
            id,
            actor.workspaceId,
            input.content ?? null,
            input.scope ?? null,
            input.metadata === undefined ? null : JSON.stringify(input.metadata),
            currentMemory.version,
          ],
        );
        const updated = result.rows[0];
        if (!updated) {
          throw new MemoryVersionConflictError(currentMemory.version, currentMemory.version + 1);
        }
        if (updated && chunks) {
          await transaction.query(
            "DELETE FROM memory_chunks WHERE workspace_id = $1 AND memory_id = $2",
            [actor.workspaceId, id],
          );
          await insertChunks(transaction, actor.workspaceId, id, chunks);
        }
        const jobId =
          updated && embeddingProvider
            ? await enqueueEmbeddingJob(transaction, updated, embeddingProvider, chunks === null)
            : null;
        const updatedMemory = toMemory(updated);
        await completeMutation(
          transaction,
          claim.requestId,
          200,
          { memory: updatedMemory },
          Boolean(options.idempotency),
        );
        return { memory: updatedMemory, jobId, chunksChanged: chunks !== null };
      });
      // Metadata-only updates can leave an existing stale job for the scheduled
      // sweep without billing a Queue message for an already-embedded Memory.
      notifyMaintenance(updatedResult.chunksChanged ? updatedResult.jobId : null);
      return updatedResult.memory;
    },

    async forget(
      actor: ActorContext,
      id: string,
      options: MemoryMutationOptions = {},
    ): Promise<boolean> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const claim = await beginMutation<{ deleted: boolean }>(
          transaction,
          actor,
          options.idempotency,
        );
        if (claim.replay) return claim.replay.body.deleted;
        const current = await transaction.query<{ version: number }>(
          `SELECT version
           FROM memories
           WHERE id = $1
             AND workspace_id = $2
             AND lore.can_write_memory(workspace_id, owner_user_id)
           FOR UPDATE`,
          [id, actor.workspaceId],
        );
        const currentVersion = current.rows[0]?.version;
        if (currentVersion === undefined) {
          await completeMutation(
            transaction,
            claim.requestId,
            404,
            { deleted: false },
            Boolean(options.idempotency),
          );
          return false;
        }
        if (options.expectedVersion !== undefined && currentVersion !== options.expectedVersion) {
          throw new MemoryVersionConflictError(options.expectedVersion, currentVersion);
        }
        const result = await transaction.query<{ id: string }>(
          `DELETE FROM memories
           WHERE id = $1 AND workspace_id = $2 AND version = $3
           RETURNING id`,
          [id, actor.workspaceId, currentVersion],
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
    },

    async list(actor: ActorContext, input: ListMemory = {}): Promise<Memory[]> {
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      const offset = Math.max(0, Math.min(input.offset ?? 0, 1_000_000));
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<MemoryRow>(
          `SELECT id, workspace_id, owner_user_id, created_by_agent_id, scope,
                  content, metadata, version, created_at,
                  to_char(
                    updated_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  ) AS updated_at
           FROM memories
           WHERE workspace_id = $1
             AND ($4::memory_scope IS NULL OR scope = $4::memory_scope)
             AND ($5::timestamptz IS NULL OR updated_at >= $5::timestamptz)
             AND ($6::timestamptz IS NULL OR updated_at < $6::timestamptz)
             AND ($7::jsonb IS NULL OR metadata @> $7::jsonb)
             AND (
               $8::timestamptz IS NULL
               OR updated_at < $8::timestamptz
               OR (
                 updated_at = $8::timestamptz
                 AND id > $9::uuid
               )
             )
           ORDER BY updated_at DESC, id
           LIMIT $2
           OFFSET $3`,
          [
            actor.workspaceId,
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
        return result.rows.map(toMemory);
      });
    },

    async search(actor: ActorContext, input: SearchMemory): Promise<MemorySearchResult[]> {
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
      const queryEmbeddings = await embedRetrievalQueries(embeddingProvider, queries);
      let fusionResults: MemorySearchResult[] = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const resultSets: MemorySearchResult[][] = [];
        for (const [index, plannedQuery] of queries.entries()) {
          resultSets.push(
            await searchOneQuery({
              transaction,
              actor,
              query: plannedQuery,
              queryEmbedding: queryEmbeddings[index] ?? null,
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
              actor,
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
      for (let round = 0; round < retrievalFeedbackQueries; round += 1) {
        const feedback = feedbackRetrievalQueries(feedbackSeedQuery, feedbackSources, 1)[0];
        if (!feedback) break;
        feedbackSourceIds.add(feedback.excludedMemoryId);
        const [feedbackEmbedding] = await embedRetrievalQueries(embeddingProvider, [
          feedback.query,
        ]);
        const feedbackRead = await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
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
              actor.workspaceId,
              fusionResults.map((result) => result.memory.id),
              scope,
              updatedAfter,
              updatedBefore,
              metadataFilter ? JSON.stringify(metadataFilter) : null,
            ],
          );
          const results = await searchOneQuery({
            transaction,
            actor,
            query: feedback.query,
            queryEmbedding: feedbackEmbedding ?? null,
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
        fusionResults = appendFeedbackResults(
          fusionResults.filter((result) => feedbackRead.visibleMemoryIds.has(result.memory.id)),
          feedbackRead.results,
          resultLimit,
        );
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

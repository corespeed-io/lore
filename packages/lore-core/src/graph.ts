import type { MemoryStorageContext, PostgresTransaction } from "./db";
import type { Memory, MemoryScope } from "./memory";

export interface MemoryGraphNode {
  id: string;
  reference: string;
  label: string;
  preview: string;
  scope: MemoryScope;
  type: string;
  updatedAt: string;
}

export interface MemoryGraphLink {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
}

export interface MemoryLink {
  id: string;
  partitionId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectMemories {
  sourceMemoryId: string;
  targetMemoryId: string;
  kind?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface ReadMemoryGraph {
  limit?: number;
  maxNeighbors?: number;
  minimumAffinity?: number;
}

interface GraphMemoryRow {
  id: string;
  scope: MemoryScope;
  /** The whole content when `content_complete`, otherwise a leading prefix. */
  content: string;
  content_complete: boolean;
  metadata: Record<string, unknown>;
  version: number;
  updated_at: string;
}

interface MemoryLinkRow {
  id: string;
  workspace_id: string;
  source_memory_id: string;
  target_memory_id: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

type GraphMemory = Pick<
  Memory,
  "id" | "scope" | "content" | "metadata" | "updatedAt" | "version"
> & {
  /** False when `content` is only a leading prefix of the Memory content. */
  contentComplete: boolean;
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "been",
  "before",
  "being",
  "but",
  "can",
  "could",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "into",
  "its",
  "more",
  "not",
  "our",
  "should",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "through",
  "was",
  "were",
  "will",
  "with",
  "would",
  "your",
]);
const AFFINITY_NODE_CAP = 500;
/**
 * Code points of content read for every node. A node needs only a 240-character
 * preview and a short label, so the read transfers this bounded prefix and
 * fetches complete content only for affinity candidates and for prefixes that
 * cannot decide their node text.
 */
const GRAPH_CONTENT_PREFIX_CHARACTERS = 1_000;
const SENTENCE_BREAK = /(?<=[.!?。！？])\s/u;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const integer = Number.isFinite(value) ? Math.floor(value ?? fallback) : fallback;
  return Math.max(minimum, Math.min(integer, maximum));
}

function memoryPreview(content: string, limit: number): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1).trimEnd()}…` : compact;
}

/**
 * {@link memoryPreview} of a text known only through `prefix`, or null when
 * the prefix cannot decide it. Collapsing whitespace runs is local, so the
 * collapsed prefix is a prefix of the collapsed whole; once it holds a
 * non-space character past `limit`, the whole is longer than `limit` and its
 * first `limit - 1` characters are already known.
 */
function prefixPreview(prefix: string, limit: number): string | null {
  const collapsed = prefix.replace(/\s+/g, " ").trimStart();
  if (collapsed.trimEnd().length <= limit) return null;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/** The node label, or null when a content prefix cannot decide it. */
function memoryLabel(memory: GraphMemory): string | null {
  const configured = memory.metadata.title;
  if (typeof configured === "string" && configured.trim()) {
    return memoryPreview(configured, 96);
  }
  const { content } = memory;
  if (memory.contentComplete) {
    // split with a limit of 1 always yields one element; the fallback is inert.
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    const firstSentence = firstLine.split(SENTENCE_BREAK, 1)[0];
    return memoryPreview(firstSentence || content, 72);
  }
  if (content.includes("\n")) {
    // The first line break lies inside the prefix, so the first line is exact.
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    const firstSentence = firstLine.split(SENTENCE_BREAK, 1)[0];
    return firstSentence ? memoryPreview(firstSentence, 72) : prefixPreview(content, 72);
  }
  // A sentence break inside the prefix ends the first sentence exactly.
  const firstSentence = content.split(SENTENCE_BREAK, 1)[0] ?? "";
  if (firstSentence.length < content.length) return memoryPreview(firstSentence, 72);
  // The first sentence runs past the prefix; a trailing CR may open a CRLF break.
  return prefixPreview(content.replace(/\r$/, ""), 72);
}

function memoryReference(memory: GraphMemory): string {
  const configured = memory.metadata.reference;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const legacy = memory.metadata.legacy;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const slug = (legacy as Record<string, unknown>).slug;
    if (typeof slug === "string" && slug.trim()) return slug.trim();
  }
  return memory.id;
}

function termsFor(content: string): Set<string> {
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set<string>();
  for (const term of normalized.match(/[a-z0-9][a-z0-9_-]{1,63}/g) ?? []) {
    if (!STOP_WORDS.has(term)) terms.add(term);
  }
  for (const run of normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  ) ?? []) {
    const characters = [...run];
    if (characters.length < 2) continue;
    if (characters.length === 2) terms.add(run);
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return terms;
}

function affinity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection += 1;
  }
  return intersection / Math.sqrt(left.size * right.size);
}

function toMemory(row: GraphMemoryRow): GraphMemory {
  return {
    id: row.id,
    scope: row.scope,
    content: row.content,
    contentComplete: row.content_complete,
    metadata: row.metadata,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function toMemoryLink(row: MemoryLinkRow): MemoryLink {
  return {
    id: row.id,
    partitionId: row.workspace_id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    kind: row.kind,
    weight: row.weight,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function affinityLinks(memories: GraphMemory[], input: ReadMemoryGraph): MemoryGraphLink[] {
  const termSets = new Map(memories.map((memory) => [memory.id, termsFor(memory.content)]));
  const requestedAffinity = input.minimumAffinity ?? 0.16;
  const minimumAffinity = Number.isFinite(requestedAffinity)
    ? Math.max(0, Math.min(requestedAffinity, 1))
    : 0.16;
  const maxNeighbors = boundedInteger(input.maxNeighbors, 3, 1, 8);
  const candidates: MemoryGraphLink[] = [];
  for (let leftIndex = 0; leftIndex < memories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memories.length; rightIndex += 1) {
      const left = memories[leftIndex];
      const right = memories[rightIndex];
      if (!left || !right) continue;
      const weight = affinity(
        termSets.get(left.id) ?? new Set(),
        termSets.get(right.id) ?? new Set(),
      );
      if (weight < minimumAffinity) continue;
      const [source, target] = [left.id, right.id].sort();
      if (!source || !target) continue;
      candidates.push({ source, target, kind: "affinity", weight: Number(weight.toFixed(4)) });
    }
  }

  candidates.sort(
    (left, right) =>
      right.weight - left.weight ||
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target),
  );
  const selectedPairs = new Set<string>();
  const neighbors = new Map<string, number>();
  for (const candidate of candidates) {
    const sourceNeighbors = neighbors.get(candidate.source) ?? 0;
    const targetNeighbors = neighbors.get(candidate.target) ?? 0;
    if (sourceNeighbors >= maxNeighbors || targetNeighbors >= maxNeighbors) continue;
    selectedPairs.add(`${candidate.source}:${candidate.target}`);
    neighbors.set(candidate.source, sourceNeighbors + 1);
    neighbors.set(candidate.target, targetNeighbors + 1);
  }
  return candidates.filter((candidate) =>
    selectedPairs.has(`${candidate.source}:${candidate.target}`),
  );
}

/** The node for one Memory, or null when its content prefix cannot decide it. */
function graphNode(memory: GraphMemory): MemoryGraphNode | null {
  const label = memoryLabel(memory);
  const preview = memory.contentComplete
    ? memoryPreview(memory.content, 240)
    : prefixPreview(memory.content, 240);
  if (label === null || preview === null) return null;
  return {
    id: memory.id,
    reference: memoryReference(memory),
    label,
    preview,
    scope: memory.scope,
    type:
      typeof memory.metadata.type === "string" && memory.metadata.type.trim()
        ? memory.metadata.type.trim()
        : memory.scope,
    updatedAt: new Date(memory.updatedAt).toISOString(),
  };
}

/** The otherwise isolated Memories that may receive derived affinity links. */
function affinityCandidates(memories: GraphMemory[], storedLinks: MemoryLinkRow[]): GraphMemory[] {
  const explicitlyLinkedIds = new Set(
    storedLinks.flatMap((link) => [link.source_memory_id, link.target_memory_id]),
  );
  return memories
    .filter((memory) => !explicitlyLinkedIds.has(memory.id))
    .slice(0, AFFINITY_NODE_CAP);
}

/** Memories whose graph output depends on content past their bounded prefix. */
function completeContentIds(memories: GraphMemory[], storedLinks: MemoryLinkRow[]): string[] {
  const ids = new Set(
    affinityCandidates(memories, storedLinks)
      .filter((memory) => !memory.contentComplete)
      .map((memory) => memory.id),
  );
  for (const memory of memories) {
    if (!memory.contentComplete && graphNode(memory) === null) ids.add(memory.id);
  }
  return [...ids];
}

function buildGraph(
  memories: GraphMemory[],
  storedLinks: MemoryLinkRow[],
  input: ReadMemoryGraph,
): MemoryGraph {
  const nodes = memories.map((memory) => {
    const node = graphNode(memory);
    if (!node) throw new Error("Memory Graph node content was not resolved");
    return node;
  });
  const explicitLinks = storedLinks.map((link) => ({
    source: link.source_memory_id,
    target: link.target_memory_id,
    kind: link.kind,
    weight: Number(link.weight),
  }));
  const isolatedMemories = affinityCandidates(memories, storedLinks);
  if (isolatedMemories.some((memory) => !memory.contentComplete)) {
    throw new Error("Memory Graph affinity content was not resolved");
  }
  return {
    nodes,
    links: [...explicitLinks, ...affinityLinks(isolatedMemories, input)],
  };
}

/**
 * Read up to `limit` node rows and the Memory Links among them. Each row
 * carries at most `prefixCharacters` code points of content, or its complete
 * content when `prefixCharacters` is null.
 */
async function readGraphRows(
  transaction: PostgresTransaction,
  partitionId: string,
  limit: number,
  prefixCharacters: number | null,
): Promise<{ memories: GraphMemory[]; links: MemoryLinkRow[] }> {
  // Reading one code point past the bound tells complete content from a cut.
  const memoryResult = await transaction.query<GraphMemoryRow>(
    `SELECT
       id,
       scope,
       metadata,
       version,
       updated_at,
       CASE
         WHEN $3::integer IS NULL THEN content
         ELSE substr(content, 1, $3::integer + 1)
       END AS content,
       $3::integer IS NULL
         OR char_length(substr(content, 1, $3::integer + 1)) <= $3::integer AS content_complete
     FROM memories
     WHERE workspace_id = $1
     ORDER BY updated_at DESC, id
     LIMIT $2`,
    [partitionId, limit, prefixCharacters],
  );
  if (memoryResult.rows.length === 0) return { memories: [], links: [] };
  const memoryIds = memoryResult.rows.map((memory) => memory.id);
  const linkResult = await transaction.query<MemoryLinkRow>(
    `SELECT *
     FROM memory_links
     WHERE workspace_id = $1
       AND source_memory_id = ANY($2::uuid[])
       AND target_memory_id = ANY($2::uuid[])
     ORDER BY created_at, id`,
    [partitionId, memoryIds],
  );
  return { memories: memoryResult.rows.map(toMemory), links: linkResult.rows };
}

/**
 * Memory Graph and durable Memory Links over a host-scoped database.
 * The host owns visibility and write authorization for both link endpoints.
 */
export function createMemoryGraphModule(storage: MemoryStorageContext) {
  const { database } = storage;
  return {
    async connect(input: ConnectMemories): Promise<MemoryLink> {
      const kind = input.kind?.trim() || "related";
      const requestedWeight = input.weight ?? 1;
      const weight = Number.isFinite(requestedWeight)
        ? Math.max(0, Math.min(requestedWeight, 1))
        : 1;
      return database.transaction(async (transaction) => {
        const result = await transaction.query<MemoryLinkRow>(
          `INSERT INTO memory_links (
             id, workspace_id, source_memory_id, target_memory_id, kind, weight, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           RETURNING *`,
          [
            crypto.randomUUID(),
            storage.partitionId,
            input.sourceMemoryId,
            input.targetMemoryId,
            kind,
            weight,
            JSON.stringify(input.metadata ?? {}),
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Memory link insert returned no row");
        return toMemoryLink(row);
      });
    },

    async read(input: ReadMemoryGraph = {}): Promise<MemoryGraph> {
      const limit = boundedInteger(input.limit, 5_000, 1, 5_000);
      return database.transaction(async (transaction) => {
        const bounded = await readGraphRows(
          transaction,
          storage.partitionId,
          limit,
          GRAPH_CONTENT_PREFIX_CHARACTERS,
        );
        const requiredIds = completeContentIds(bounded.memories, bounded.links);
        if (requiredIds.length === 0) return buildGraph(bounded.memories, bounded.links, input);
        const completeResult = await transaction.query<{
          id: string;
          version: number;
          content: string;
        }>(
          `SELECT id, version, content
           FROM memories
           WHERE workspace_id = $1
             AND id = ANY($2::uuid[])`,
          [storage.partitionId, requiredIds],
        );
        const completeById = new Map(completeResult.rows.map((row) => [row.id, row] as const));
        const versionById = new Map(
          bounded.memories.map((memory) => [memory.id, memory.version] as const),
        );
        const unchanged = requiredIds.every(
          (id) => completeById.get(id)?.version === versionById.get(id),
        );
        if (!unchanged) {
          // A write between statements changed or hid a Memory whose complete
          // content is needed. Reread every node in full so the whole graph
          // again comes from one statement's snapshot.
          const reread = await readGraphRows(transaction, storage.partitionId, limit, null);
          return buildGraph(reread.memories, reread.links, input);
        }
        const memories = bounded.memories.map((memory) => {
          const complete = completeById.get(memory.id);
          return complete
            ? { ...memory, content: complete.content, contentComplete: true }
            : memory;
        });
        return buildGraph(memories, bounded.links, input);
      });
    },
  };
}

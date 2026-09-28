import { queryInRecordBatches } from "./batch";
import type { MemoryStorageContext, PostgresTransaction } from "./db";
import type { Memory, MemoryScope } from "./memory";
import { validateMemoryMetadata } from "./memory-input";
import { utcTimestampSql } from "./timestamp";
import { boundedInteger, isStorableText, LoreValidationError } from "./validation";

export const MEMORY_GRAPH_LIMITS = {
  /** Visible Memories one Graph read returns at most. */
  maximumNodes: 5_000,
  /**
   * Durable Memory Links one Graph read returns at most, in creation order. A cut
   * takes each source owner's newest Links in turn, so no owner's Links crowd out
   * another's, and says it cut.
   */
  maximumLinks: 40_000,
} as const;

export const MEMORY_LINK_LIMITS = {
  /** Link kind length, in UTF-16 code units. */
  maximumKindLength: 64,
  defaultKind: "related",
  minimumWeight: 0,
  maximumWeight: 1,
  defaultWeight: 1,
  /** `JSON.stringify` length of one Link's metadata, in UTF-16 code units. */
  maximumMetadataSerializedLength: 1_000,
  // `connect` refuses a new Link past each bound below. Each counts only Links
  // from the writer's own Memories, so no writer's Links spend another's quota, and
  // only those the writer can see, so under RLS these bound each write rather than
  // every stored row.
  /** Links from one source Memory. */
  maximumLinksPerSource: 1_000,
  /** Links from one owner's Memories to one target Memory. */
  maximumLinksPerTarget: 1_000,
  /** Kinds from one Memory to another; the reverse direction is a separate pair. */
  maximumKindsPerPair: 16,
  /** Links from one owner's Memories in a partition, a Lore OSS Workspace archive's worth. */
  maximumLinksPerOwner: 50_000,
  defaultListLimit: 50,
  maximumListLimit: 100,
} as const;

/** Which end of its Links a listed Memory is. */
export const MEMORY_LINK_DIRECTIONS = ["outbound", "inbound"] as const;
export type MemoryLinkDirection = (typeof MEMORY_LINK_DIRECTIONS)[number];

type MemoryLinkBound =
  | "maximumLinksPerSource"
  | "maximumLinksPerTarget"
  | "maximumKindsPerPair"
  | "maximumLinksPerOwner";

/**
 * `connect` refused to create a Link past one of the `MEMORY_LINK_LIMITS` bounds,
 * which `limit` names. Replacing an existing Link's weight or metadata is never
 * refused.
 */
export class MemoryLinkCapacityError extends Error {
  override name = "MemoryLinkCapacityError";

  constructor(
    readonly limit: MemoryLinkBound,
    message: string,
  ) {
    super(message);
  }
}

const MEMORY_LINK_BOUND_MESSAGES: Readonly<Record<MemoryLinkBound, string>> = {
  maximumKindsPerPair: `A Memory may link to another Memory with at most ${MEMORY_LINK_LIMITS.maximumKindsPerPair} kinds`,
  maximumLinksPerSource: `A Memory may be the source of at most ${MEMORY_LINK_LIMITS.maximumLinksPerSource} Memory Links`,
  maximumLinksPerTarget: `One owner's Memories may link to one Memory at most ${MEMORY_LINK_LIMITS.maximumLinksPerTarget} times`,
  maximumLinksPerOwner: `One owner's Memories may be the source of at most ${MEMORY_LINK_LIMITS.maximumLinksPerOwner} Memory Links in a Workspace`,
};

export interface ValidMemoryLink {
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
}

/**
 * The natural key that identifies one Memory Link: its two endpoints and its kind.
 * The kind is stored exactly as given; an invalid one is refused, never trimmed.
 */
export function validateMemoryLinkKey(
  input: { sourceMemoryId: string; targetMemoryId: string; kind?: unknown },
  field = "link",
): { kind: string } {
  // UUIDs compare case-insensitively, as PostgreSQL compares them.
  if (input.sourceMemoryId.toLowerCase() === input.targetMemoryId.toLowerCase()) {
    throw new LoreValidationError(field, `${field} must connect two different Memories`);
  }
  const kind = input.kind === undefined ? MEMORY_LINK_LIMITS.defaultKind : input.kind;
  if (
    typeof kind !== "string" ||
    !kind.trim() ||
    !isStorableText(kind) ||
    kind.length > MEMORY_LINK_LIMITS.maximumKindLength
  ) {
    throw new LoreValidationError(
      `${field}.kind`,
      `${field}.kind must be non-blank text of at most ${MEMORY_LINK_LIMITS.maximumKindLength} characters`,
    );
  }
  return { kind };
}

/**
 * The rules every durable Memory Link obeys, however it is written. Values are
 * stored exactly as given; an invalid kind or weight is refused, never trimmed or
 * clamped.
 */
export function validateMemoryLink(
  input: {
    sourceMemoryId: string;
    targetMemoryId: string;
    kind?: unknown;
    weight?: unknown;
    metadata?: unknown;
  },
  field = "link",
): ValidMemoryLink {
  const { kind } = validateMemoryLinkKey(input, field);
  const weight = input.weight === undefined ? MEMORY_LINK_LIMITS.defaultWeight : input.weight;
  if (
    typeof weight !== "number" ||
    !Number.isFinite(weight) ||
    weight < MEMORY_LINK_LIMITS.minimumWeight ||
    weight > MEMORY_LINK_LIMITS.maximumWeight
  ) {
    throw new LoreValidationError(
      `${field}.weight`,
      `${field}.weight must be a number from ${MEMORY_LINK_LIMITS.minimumWeight} through ${MEMORY_LINK_LIMITS.maximumWeight}`,
    );
  }
  // Weights are stored as PostgreSQL `real` (a 32-bit float), which refuses a
  // non-zero value that would round to zero. Test the rounding itself: PostgreSQL
  // prints the smallest real as 1e-45, below 2 ** -149, and that must import again.
  if (weight !== 0 && Math.fround(weight) === 0) {
    throw new LoreValidationError(
      `${field}.weight`,
      `${field}.weight must be 0 or a value PostgreSQL real does not round to zero`,
    );
  }
  const metadata =
    input.metadata === undefined ? {} : validateMemoryMetadata(input.metadata, `${field}.metadata`);
  // A Link annotates a relationship; its metadata stays small enough that Links
  // cannot spend a Workspace archive's byte budget faster than its Link count.
  if (JSON.stringify(metadata).length > MEMORY_LINK_LIMITS.maximumMetadataSerializedLength) {
    throw new LoreValidationError(
      `${field}.metadata`,
      `${field}.metadata exceeds ${MEMORY_LINK_LIMITS.maximumMetadataSerializedLength} characters`,
    );
  }
  return { kind, weight, metadata };
}

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
  /** True for a derived affinity edge, false for a durable Memory Link. */
  derived: boolean;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  /**
   * True when the read cut durable Links at `MEMORY_GRAPH_LIMITS.maximumLinks`.
   * Isolation is then unknown, so no affinity edge is derived.
   */
  linksTruncated: boolean;
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

/** The Link one `connect` left in place, and whether that call created it. */
export interface ConnectedMemoryLink {
  link: MemoryLink;
  created: boolean;
}

export interface DisconnectMemories {
  sourceMemoryId: string;
  targetMemoryId: string;
  kind?: string;
}

/** Where one page of a Link list ends: its last Link's creation time and id. */
export interface MemoryLinkCursor {
  createdAt: string;
  id: string;
}

export interface ListMemoryLinks {
  memoryId: string;
  direction?: MemoryLinkDirection;
  limit?: number;
  cursor?: MemoryLinkCursor;
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

/** The columns of a Link the Graph returns; metadata never leaves the database. */
interface GraphLinkRow {
  source_memory_id: string;
  target_memory_id: string;
  kind: string;
  weight: number;
}

/** The durable Links among one read's nodes, and whether the link budget cut them. */
interface StoredGraphLinks {
  links: GraphLinkRow[];
  truncated: boolean;
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

/** An internal read option, clamped into range; request input is refused instead. */
function clampedInteger(
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
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const firstSentence = firstLine.split(SENTENCE_BREAK, 1)[0] ?? "";
  if (memory.contentComplete) return memoryPreview(firstSentence || content, 72);
  if (content.includes("\n")) {
    // The first line break lies inside the prefix, so the first line is exact.
    return firstSentence ? memoryPreview(firstSentence, 72) : prefixPreview(content, 72);
  }
  // A sentence break inside the prefix ends the first sentence exactly.
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

/** A Link row with canonical microsecond RFC 3339 timestamps, not driver `Date`s. */
const MEMORY_LINK_COLUMNS = [
  "id",
  "workspace_id",
  "source_memory_id",
  "target_memory_id",
  "kind",
  "weight",
  "metadata",
  `${utcTimestampSql("created_at")} AS created_at`,
  `${utcTimestampSql("updated_at")} AS updated_at`,
].join(", ");

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
  const termSets = memories.map((memory) => ({ id: memory.id, terms: termsFor(memory.content) }));
  const requestedAffinity = input.minimumAffinity ?? 0.16;
  const minimumAffinity = Number.isFinite(requestedAffinity)
    ? Math.max(0, Math.min(requestedAffinity, 1))
    : 0.16;
  const maxNeighbors = clampedInteger(input.maxNeighbors, 3, 1, 8);
  const candidates: MemoryGraphLink[] = [];
  for (const [leftIndex, left] of termSets.entries()) {
    for (const right of termSets.slice(leftIndex + 1)) {
      const weight = affinity(left.terms, right.terms);
      if (weight < minimumAffinity) continue;
      const [source, target] = left.id < right.id ? [left.id, right.id] : [right.id, left.id];
      candidates.push({
        source,
        target,
        kind: "affinity",
        weight: Number(weight.toFixed(4)),
        derived: true,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      right.weight - left.weight ||
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target),
  );
  const selected: MemoryGraphLink[] = [];
  const neighbors = new Map<string, number>();
  for (const candidate of candidates) {
    const sourceNeighbors = neighbors.get(candidate.source) ?? 0;
    const targetNeighbors = neighbors.get(candidate.target) ?? 0;
    if (sourceNeighbors >= maxNeighbors || targetNeighbors >= maxNeighbors) continue;
    selected.push(candidate);
    neighbors.set(candidate.source, sourceNeighbors + 1);
    neighbors.set(candidate.target, targetNeighbors + 1);
  }
  return selected;
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

/**
 * The otherwise isolated Memories that may receive derived affinity links. None
 * when the durable Links were cut, since a cut one might have linked any of them.
 */
function affinityCandidates(memories: GraphMemory[], stored: StoredGraphLinks): GraphMemory[] {
  if (stored.truncated) return [];
  const explicitlyLinkedIds = new Set(
    stored.links.flatMap((link) => [link.source_memory_id, link.target_memory_id]),
  );
  return memories
    .filter((memory) => !explicitlyLinkedIds.has(memory.id))
    .slice(0, AFFINITY_NODE_CAP);
}

/** Memories whose graph output depends on content past their bounded prefix. */
function completeContentIds(memories: GraphMemory[], stored: StoredGraphLinks): string[] {
  const ids = new Set(
    affinityCandidates(memories, stored)
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
  stored: StoredGraphLinks,
  input: ReadMemoryGraph,
): MemoryGraph {
  const nodes = memories.map((memory) => {
    const node = graphNode(memory);
    if (!node) throw new Error("Memory Graph node content was not resolved");
    return node;
  });
  const explicitLinks = stored.links.map((link) => ({
    source: link.source_memory_id,
    target: link.target_memory_id,
    kind: link.kind,
    weight: Number(link.weight),
    derived: false,
  }));
  const isolatedMemories = affinityCandidates(memories, stored);
  if (isolatedMemories.some((memory) => !memory.contentComplete)) {
    throw new Error("Memory Graph affinity content was not resolved");
  }
  return {
    nodes,
    links: [...explicitLinks, ...affinityLinks(isolatedMemories, input)],
    linksTruncated: stored.truncated,
  };
}

/**
 * Read up to `limit` node rows, newest first, and the newest
 * `MEMORY_GRAPH_LIMITS.maximumLinks` Memory Links among them, in creation order.
 * Each node row carries at most `prefixCharacters` code points of content, or its
 * complete content when `prefixCharacters` is null.
 */
async function readGraphRows(
  transaction: PostgresTransaction,
  partitionId: string,
  limit: number,
  prefixCharacters: number | null,
): Promise<{ memories: GraphMemory[]; stored: StoredGraphLinks }> {
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
  if (memoryResult.rows.length === 0) {
    return { memories: [], stored: { links: [], truncated: false } };
  }
  const memoryIds = memoryResult.rows.map((memory) => memory.id);
  // Reading one Link past the budget tells a complete set from a cut one. A cut
  // takes each source owner's newest Link, then each owner's next newest, and so
  // on, so every owner keeps at least an equal share and no owner's Links crowd
  // out another's; a Link just written is its owner's first choice. The bound
  // limits the response, not the ranking, which still reads every candidate.
  const linkResult = await transaction.query<GraphLinkRow & { priority: number }>(
    `WITH ranked AS (
       SELECT link.source_memory_id, link.target_memory_id, link.kind, link.weight,
              link.created_at, link.id,
              row_number() OVER (
                PARTITION BY owned.owner_user_id ORDER BY link.created_at DESC, link.id DESC
              ) AS owner_rank
       FROM memory_links link
       JOIN memories owned
         ON owned.workspace_id = link.workspace_id
        AND owned.id = link.source_memory_id
       WHERE link.workspace_id = $1
         AND link.source_memory_id = ANY($2::uuid[])
         AND link.target_memory_id = ANY($2::uuid[])
     ),
     chosen AS (
       SELECT ranked.*,
              (row_number() OVER (ORDER BY owner_rank, created_at DESC, id DESC))::integer
                AS priority
       FROM ranked
       ORDER BY priority
       LIMIT $3
     )
     SELECT source_memory_id, target_memory_id, kind, weight, priority
     FROM chosen
     ORDER BY created_at, id`,
    [partitionId, memoryIds, MEMORY_GRAPH_LIMITS.maximumLinks + 1],
  );
  const truncated = linkResult.rows.length > MEMORY_GRAPH_LIMITS.maximumLinks;
  const links = linkResult.rows
    .filter((row) => row.priority <= MEMORY_GRAPH_LIMITS.maximumLinks)
    .map(({ priority: _priority, ...link }) => link);
  return {
    memories: memoryResult.rows.map(toMemory),
    stored: { links, truncated },
  };
}

/**
 * Insert many Memory Links in bounded set-based batches. Each obeys the Link rules;
 * a Link that duplicates an existing (source, target, kind) is skipped. Returns the
 * ids of the Links actually inserted.
 */
export async function insertMemoryLinksInTransaction(
  transaction: PostgresTransaction,
  partitionId: string,
  links: readonly ConnectMemories[],
): Promise<string[]> {
  const records = links.map((link, index) => {
    const { kind, weight, metadata } = validateMemoryLink(link, `links[${index}]`);
    return {
      source_memory_id: link.sourceMemoryId,
      target_memory_id: link.targetMemoryId,
      kind,
      weight,
      metadata,
    };
  });
  const inserted = await queryInRecordBatches(
    transaction,
    `INSERT INTO memory_links (
       id, workspace_id, source_memory_id, target_memory_id, kind, weight, metadata
     )
     SELECT gen_random_uuid(), $2::uuid, record.source_memory_id, record.target_memory_id,
            record.kind, record.weight, record.metadata
     FROM jsonb_to_recordset($1::jsonb) AS record(
       source_memory_id uuid, target_memory_id uuid, kind text, weight real, metadata jsonb
     )
     ON CONFLICT (workspace_id, source_memory_id, target_memory_id, kind) DO NOTHING
     RETURNING id`,
    records,
    [partitionId],
  );
  return inserted.map((row) => row.id);
}

/**
 * Lock a Link's source Memory for writing, provided its target is visible too.
 * False when the store cannot lock the source or see the target. Every `connect`
 * and `disconnect` from one source serializes on this lock, which makes
 * `connect`'s `created` exact among them; batch inserts do not take it. A NO KEY
 * lock still lets other Links target the source Memory.
 */
async function lockLinkEndpoints(
  transaction: PostgresTransaction,
  partitionId: string,
  input: { sourceMemoryId: string; targetMemoryId: string },
): Promise<boolean> {
  const locked = await transaction.query<{ id: string }>(
    `SELECT source.id
     FROM memories source
     WHERE source.workspace_id = $1
       AND source.id = $2
       AND EXISTS (
         SELECT 1 FROM memories target
         WHERE target.workspace_id = $1 AND target.id = $3
       )
     FOR NO KEY UPDATE`,
    [partitionId, input.sourceMemoryId, input.targetMemoryId],
  );
  return locked.rows.length === 1;
}

/**
 * Memory Graph and durable Memory Links over a host-scoped database.
 * The host owns visibility and write authorization for both link endpoints.
 */
export function createMemoryGraphModule(storage: MemoryStorageContext) {
  const { database } = storage;
  return {
    /**
     * Create the Link with this natural key (source, target, kind), or replace an
     * existing one's weight and metadata; a repeat with the same values changes
     * nothing. Returns null when the store cannot lock the source Memory for writing
     * or cannot see the target, so the host's write and read policies decide it, and
     * when the store stops showing an existing Link before its replacement lands. A
     * target that vanishes before a new Link's insert surfaces as the database's
     * error (under RLS a policy refusal, else a foreign-key violation) for the host
     * to map. Throws MemoryLinkCapacityError instead of creating a Link past a
     * `MEMORY_LINK_LIMITS` bound.
     */
    async connect(input: ConnectMemories): Promise<ConnectedMemoryLink | null> {
      const { kind, weight, metadata } = validateMemoryLink(input);
      return database.transaction(async (transaction) => {
        if (!(await lockLinkEndpoints(transaction, storage.partitionId, input))) return null;
        const readExisting = async () =>
          (
            await transaction.query<MemoryLinkRow & { unchanged: boolean }>(
              `SELECT ${MEMORY_LINK_COLUMNS},
                      (weight, metadata) IS NOT DISTINCT FROM ($5::real, $6::jsonb) AS unchanged
               FROM memory_links
               WHERE workspace_id = $1
                 AND source_memory_id = $2
                 AND target_memory_id = $3
                 AND kind = $4
               FOR UPDATE`,
              [
                storage.partitionId,
                input.sourceMemoryId,
                input.targetMemoryId,
                kind,
                weight,
                JSON.stringify(metadata),
              ],
            )
          ).rows[0];
        const replace = async (
          current: MemoryLinkRow & { unchanged: boolean },
        ): Promise<ConnectedMemoryLink | null> => {
          // An unchanged repeat writes nothing, so it emits no Link event either.
          if (current.unchanged) return { link: toMemoryLink(current), created: false };
          const updated = await transaction.query<MemoryLinkRow>(
            `UPDATE memory_links
             SET weight = $2::real, metadata = $3::jsonb, updated_at = now()
             WHERE id = $1
             RETURNING ${MEMORY_LINK_COLUMNS}`,
            [current.id, weight, JSON.stringify(metadata)],
          );
          // The row is locked, so no row back means the store stopped showing it
          // (under RLS, its target turned invisible after the read): unreachable.
          const row = updated.rows[0];
          return row ? { link: toMemoryLink(row), created: false } : null;
        };
        const current = await readExisting();
        if (current) return replace(current);
        // Bound only new Links, counting only Links from this owner's own Memories so
        // no writer spends another's quota. Each count stops at its bound, however
        // many Links an import left behind; the owner's total reads up to its whole
        // bound, so its cost falls only on a writer who owns that many Links. The
        // source lock makes the source and pair counts exact among connects; the
        // target and owner counts may overshoot by concurrent writes from the same
        // owner's other Memories.
        const counts = await transaction.query<Record<MemoryLinkBound, number>>(
          `SELECT
             (SELECT count(*) FROM (
                SELECT 1 FROM memory_links
                WHERE workspace_id = $1 AND source_memory_id = $2 AND target_memory_id = $3
                LIMIT $4) AS pair)::integer AS "maximumKindsPerPair",
             (SELECT count(*) FROM (
                SELECT 1 FROM memory_links
                WHERE workspace_id = $1 AND source_memory_id = $2
                LIMIT $5) AS outbound)::integer AS "maximumLinksPerSource",
             (SELECT count(*) FROM (
                SELECT 1
                FROM memory_links link
                JOIN memories owned
                  ON owned.workspace_id = link.workspace_id
                 AND owned.id = link.source_memory_id
                WHERE link.workspace_id = $1
                  AND link.target_memory_id = $3
                  AND owned.owner_user_id = $8
                LIMIT $6) AS inbound)::integer AS "maximumLinksPerTarget",
             (SELECT count(*) FROM (
                SELECT 1
                FROM memories owned
                JOIN memory_links link
                  ON link.workspace_id = owned.workspace_id
                 AND link.source_memory_id = owned.id
                WHERE owned.workspace_id = $1
                  AND owned.owner_user_id = $8
                LIMIT $7) AS everything)::integer AS "maximumLinksPerOwner"`,
          [
            storage.partitionId,
            input.sourceMemoryId,
            input.targetMemoryId,
            MEMORY_LINK_LIMITS.maximumKindsPerPair,
            MEMORY_LINK_LIMITS.maximumLinksPerSource,
            MEMORY_LINK_LIMITS.maximumLinksPerTarget,
            MEMORY_LINK_LIMITS.maximumLinksPerOwner,
            storage.ownerId,
          ],
        );
        const counted = counts.rows[0];
        for (const bound of Object.keys(MEMORY_LINK_BOUND_MESSAGES) as MemoryLinkBound[]) {
          if ((counted?.[bound] ?? 0) >= MEMORY_LINK_LIMITS[bound]) {
            throw new MemoryLinkCapacityError(bound, MEMORY_LINK_BOUND_MESSAGES[bound]);
          }
        }
        const inserted = await transaction.query<MemoryLinkRow>(
          `INSERT INTO memory_links (
             id, workspace_id, source_memory_id, target_memory_id, kind, weight, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (workspace_id, source_memory_id, target_memory_id, kind) DO NOTHING
           RETURNING ${MEMORY_LINK_COLUMNS}`,
          [
            crypto.randomUUID(),
            storage.partitionId,
            input.sourceMemoryId,
            input.targetMemoryId,
            kind,
            weight,
            JSON.stringify(metadata),
          ],
        );
        const row = inserted.rows[0];
        if (row) return { link: toMemoryLink(row), created: true };
        // The key is taken by a Link the first read could not see: its target was
        // invisible for that statement, or a writer that skips the source lock (a
        // batch insert) added it since. Replace it if it is visible now.
        const taken = await readExisting();
        return taken ? replace(taken) : null;
      });
    },

    /**
     * Delete the Link with this natural key. Returns false when there is no such
     * Link or the store cannot lock its source Memory for writing or see its target.
     */
    async disconnect(input: DisconnectMemories): Promise<boolean> {
      const { kind } = validateMemoryLinkKey(input);
      return database.transaction(async (transaction) => {
        if (!(await lockLinkEndpoints(transaction, storage.partitionId, input))) return false;
        const deleted = await transaction.query<{ id: string }>(
          `DELETE FROM memory_links
           WHERE workspace_id = $1
             AND source_memory_id = $2
             AND target_memory_id = $3
             AND kind = $4
           RETURNING id`,
          [storage.partitionId, input.sourceMemoryId, input.targetMemoryId, kind],
        );
        return deleted.rows.length === 1;
      });
    },

    /**
     * One page of the Links from (`outbound`) or to (`inbound`) a Memory, newest
     * first, with their metadata; the store's policy decides which Links are
     * visible. Returns null when the store cannot see the Memory. Pass the last
     * Link's `createdAt` and `id` as the next page's cursor.
     */
    async list(input: ListMemoryLinks): Promise<MemoryLink[] | null> {
      const direction = input.direction ?? "outbound";
      if (!MEMORY_LINK_DIRECTIONS.includes(direction)) {
        throw new LoreValidationError(
          "direction",
          `direction must be ${MEMORY_LINK_DIRECTIONS.join(" or ")}`,
        );
      }
      const limit = boundedInteger(input.limit, "limit", {
        minimum: 1,
        maximum: MEMORY_LINK_LIMITS.maximumListLimit,
        fallback: MEMORY_LINK_LIMITS.defaultListLimit,
      });
      const cursor = input.cursor;
      if (
        cursor !== undefined &&
        (typeof cursor.createdAt !== "string" ||
          typeof cursor.id !== "string" ||
          !Number.isFinite(Date.parse(cursor.createdAt)))
      ) {
        throw new LoreValidationError("cursor", "cursor must name a Link's createdAt and id");
      }
      const anchorColumn = direction === "outbound" ? "source_memory_id" : "target_memory_id";
      return database.transaction(async (transaction) => {
        const anchor = await transaction.query<{ id: string }>(
          "SELECT id FROM memories WHERE workspace_id = $1 AND id = $2",
          [storage.partitionId, input.memoryId],
        );
        if (!anchor.rows[0]) return null;
        const links = await transaction.query<MemoryLinkRow>(
          `SELECT ${MEMORY_LINK_COLUMNS}
           FROM memory_links
           WHERE workspace_id = $1
             AND ${anchorColumn} = $2
             AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
           ORDER BY created_at DESC, id DESC
           LIMIT $5`,
          [
            storage.partitionId,
            input.memoryId,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            limit,
          ],
        );
        return links.rows.map(toMemoryLink);
      });
    },

    async read(input: ReadMemoryGraph = {}): Promise<MemoryGraph> {
      const limit = boundedInteger(input.limit, "limit", {
        minimum: 1,
        maximum: MEMORY_GRAPH_LIMITS.maximumNodes,
        fallback: MEMORY_GRAPH_LIMITS.maximumNodes,
      });
      return database.transaction(async (transaction) => {
        const bounded = await readGraphRows(
          transaction,
          storage.partitionId,
          limit,
          GRAPH_CONTENT_PREFIX_CHARACTERS,
        );
        const requiredIds = completeContentIds(bounded.memories, bounded.stored);
        if (requiredIds.length === 0) return buildGraph(bounded.memories, bounded.stored, input);
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
          return buildGraph(reread.memories, reread.stored, input);
        }
        const memories = bounded.memories.map((memory) => {
          const complete = completeById.get(memory.id);
          return complete
            ? { ...memory, content: complete.content, contentComplete: true }
            : memory;
        });
        return buildGraph(memories, bounded.stored, input);
      });
    },
  };
}

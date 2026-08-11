import { sql } from "drizzle-orm";
import { type ActorContext, installActorContext } from "./actor-context";
import type { LoreDatabase } from "./db";
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
  workspaceId: string;
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

function memoryLabel(memory: Memory): string {
  const configured = memory.metadata.title;
  if (typeof configured === "string" && configured.trim()) {
    return memoryPreview(configured, 96);
  }
  const firstLine = memory.content.split(/\r?\n/, 1)[0];
  const firstSentence = firstLine.split(/(?<=[.!?。！？])\s/u, 1)[0];
  return memoryPreview(firstSentence || memory.content, 72);
}

function memoryReference(memory: Memory): string {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemoryLink(row: MemoryLinkRow): MemoryLink {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    kind: row.kind,
    weight: row.weight,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function affinityLinks(memories: Memory[], input: ReadMemoryGraph): MemoryGraphLink[] {
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
      const weight = affinity(
        termSets.get(left.id) ?? new Set(),
        termSets.get(right.id) ?? new Set(),
      );
      if (weight < minimumAffinity) continue;
      const [source, target] = [left.id, right.id].sort();
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

function buildGraph(
  memories: Memory[],
  storedLinks: MemoryLinkRow[],
  input: ReadMemoryGraph,
): MemoryGraph {
  const nodes = memories.map((memory) => ({
    id: memory.id,
    reference: memoryReference(memory),
    label: memoryLabel(memory),
    preview: memoryPreview(memory.content, 240),
    scope: memory.scope,
    type:
      typeof memory.metadata.type === "string" && memory.metadata.type.trim()
        ? memory.metadata.type.trim()
        : memory.scope,
    updatedAt: new Date(memory.updatedAt).toISOString(),
  }));
  const explicitLinks = storedLinks.map((link) => ({
    source: link.source_memory_id,
    target: link.target_memory_id,
    kind: link.kind,
    weight: Number(link.weight),
  }));
  const explicitlyLinkedIds = new Set(explicitLinks.flatMap((link) => [link.source, link.target]));
  const isolatedMemories = memories
    .filter((memory) => !explicitlyLinkedIds.has(memory.id))
    .slice(0, AFFINITY_NODE_CAP);
  return {
    nodes,
    links: [...explicitLinks, ...affinityLinks(isolatedMemories, input)],
  };
}

/**
 * Native Memory Graph and durable Memory Link module. Every operation installs
 * Actor context before Postgres RLS selects nodes and links. Link policies require
 * both endpoints to be visible, so hidden-neighbor ids and degree never leak.
 */
export function createMemoryGraphModule(database: LoreDatabase) {
  return {
    async connect(actor: ActorContext, input: ConnectMemories): Promise<MemoryLink> {
      const kind = input.kind?.trim() || "related";
      const requestedWeight = input.weight ?? 1;
      const weight = Number.isFinite(requestedWeight)
        ? Math.max(0, Math.min(requestedWeight, 1))
        : 1;
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.execute<MemoryLinkRow>(
          sql`INSERT INTO memory_links (
             id, workspace_id, source_memory_id, target_memory_id, kind, weight, metadata
           ) VALUES (
             ${crypto.randomUUID()}, ${actor.workspaceId}, ${input.sourceMemoryId},
             ${input.targetMemoryId}, ${kind}, ${weight},
             ${JSON.stringify(input.metadata ?? {})}::jsonb
           )
           RETURNING *`,
        );
        return toMemoryLink(result.rows[0]);
      });
    },

    async read(actor: ActorContext, input: ReadMemoryGraph = {}): Promise<MemoryGraph> {
      const limit = boundedInteger(input.limit, 5_000, 1, 5_000);
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const memoryResult = await transaction.execute<MemoryRow>(
          sql`SELECT *
           FROM memories
           WHERE workspace_id = ${actor.workspaceId}
           ORDER BY updated_at DESC, id
           LIMIT ${limit}`,
        );
        if (memoryResult.rows.length === 0) return { nodes: [], links: [] };
        const memoryIds = memoryResult.rows.map((memory) => memory.id);
        const linkResult = await transaction.execute<MemoryLinkRow>(
          sql`SELECT *
           FROM memory_links
           WHERE workspace_id = ${actor.workspaceId}
             AND source_memory_id = ANY(${sql.param(memoryIds)}::uuid[])
             AND target_memory_id = ANY(${sql.param(memoryIds)}::uuid[])
           ORDER BY created_at, id`,
        );
        return buildGraph(memoryResult.rows.map(toMemory), linkResult.rows, input);
      });
    },
  };
}

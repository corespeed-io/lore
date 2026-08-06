import type { ActorContext } from "./actor-context";
import type { PostgresDatabase } from "./db";
import { createMemoryModule, type Memory, type MemoryScope } from "./memory";

export interface MemoryGraphNode {
  id: string;
  label: string;
  preview: string;
  scope: MemoryScope;
  type: string;
  updatedAt: string;
}

export interface MemoryGraphLink {
  source: string;
  target: string;
  kind: "affinity";
  weight: number;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
}

export interface ReadMemoryGraph {
  limit?: number;
  maxNeighbors?: number;
  minimumAffinity?: number;
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

function memoryPreview(content: string, limit: number): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1).trimEnd()}…` : compact;
}

function memoryLabel(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0];
  const firstSentence = firstLine.split(/(?<=[.!?。！？])\s/u, 1)[0];
  return memoryPreview(firstSentence || content, 72);
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

function buildGraph(memories: Memory[], input: ReadMemoryGraph): MemoryGraph {
  const nodes = memories.map((memory) => ({
    id: memory.id,
    label: memoryLabel(memory.content),
    preview: memoryPreview(memory.content, 240),
    scope: memory.scope,
    type:
      typeof memory.metadata.type === "string" && memory.metadata.type.trim()
        ? memory.metadata.type.trim()
        : memory.scope,
    updatedAt: new Date(memory.updatedAt).toISOString(),
  }));
  const termSets = new Map(memories.map((memory) => [memory.id, termsFor(memory.content)]));
  const minimumAffinity = Math.max(0, Math.min(input.minimumAffinity ?? 0.16, 1));
  const maxNeighbors = Math.max(1, Math.min(input.maxNeighbors ?? 3, 8));
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

  return {
    nodes,
    links: candidates.filter((candidate) =>
      selectedPairs.has(`${candidate.source}:${candidate.target}`),
    ),
  };
}

/**
 * Native Memory Graph read model. RLS is applied by the Memory module before
 * affinity links are derived, so an edge can never name an invisible endpoint.
 */
export function createMemoryGraphModule(database: PostgresDatabase) {
  const memories = createMemoryModule(database);
  return {
    async read(actor: ActorContext, input: ReadMemoryGraph = {}): Promise<MemoryGraph> {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
      return buildGraph(await memories.list(actor, { limit }), input);
    },
  };
}

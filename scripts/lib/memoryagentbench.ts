import { chunkMemoryContent } from "@corespeed/lore-core";
import manifest from "../../evaluation/external/memoryagentbench.json";
import { readJsonLines } from "./json-lines";

export const memoryAgentBenchManifest = manifest;

export interface MemoryAgentBenchRow {
  context: string;
  questions: string[];
  answers: string[][];
  metadata: {
    source: string;
    qa_pair_ids: string[];
    [key: string]: unknown;
  };
}

function nonEmptyStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Invalid MemoryAgentBench ${label}`);
  }
  return value;
}

export function parseMemoryAgentBenchRow(value: unknown): MemoryAgentBenchRow {
  if (typeof value !== "object" || value === null) throw new Error("Invalid MemoryAgentBench row");
  const row = value as Record<string, unknown>;
  if (typeof row.context !== "string" || !row.context.trim()) {
    throw new Error("Invalid MemoryAgentBench context");
  }
  const questions = nonEmptyStrings(row.questions, "questions");
  if (
    !Array.isArray(row.answers) ||
    !row.answers.every(
      (answers) =>
        Array.isArray(answers) &&
        answers.length > 0 &&
        answers.every((answer) => typeof answer === "string" && answer.trim()),
    )
  ) {
    throw new Error("Invalid MemoryAgentBench answers");
  }
  if (typeof row.metadata !== "object" || row.metadata === null) {
    throw new Error("Invalid MemoryAgentBench metadata");
  }
  const metadata = row.metadata as Record<string, unknown>;
  if (typeof metadata.source !== "string" || !metadata.source.trim()) {
    throw new Error("Invalid MemoryAgentBench source");
  }
  const qaPairIds = nonEmptyStrings(metadata.qa_pair_ids, "qa_pair_ids");
  if (questions.length !== row.answers.length || questions.length !== qaPairIds.length) {
    throw new Error(`MemoryAgentBench ${metadata.source} question arrays have different lengths`);
  }
  return {
    context: row.context,
    questions,
    answers: row.answers as string[][],
    metadata: { ...metadata, source: metadata.source, qa_pair_ids: qaPairIds },
  };
}

export async function readMemoryAgentBenchRows(filePath: string): Promise<MemoryAgentBenchRow[]> {
  const rows: MemoryAgentBenchRow[] = [];
  for await (const value of readJsonLines(filePath)) rows.push(parseMemoryAgentBenchRow(value));
  if (!rows.length) throw new Error("MemoryAgentBench file is empty");
  return rows;
}

export function chunkMemoryAgentBenchAccurateContext(
  context: string,
  maximumLength = 1_200,
): string[] {
  const normalized = context.replace(/\r\n?/g, "\n").trim();
  const markers = [...normalized.matchAll(/(?:^|\n)(Document \d+:)/g)];
  if (markers.length < 2) return chunkMemoryContent(normalized, maximumLength);

  const documents = markers.map((marker, index) => {
    const markerStart = (marker.index ?? 0) + (marker[0].startsWith("\n") ? 1 : 0);
    const next = markers[index + 1];
    const nextStart = next
      ? (next.index ?? normalized.length) + (next[0].startsWith("\n") ? 1 : 0)
      : normalized.length;
    return normalized.slice(markerStart, nextStart).trim();
  });
  return documents.flatMap((document) => chunkMemoryContent(document, maximumLength));
}

export function parseConflictResolutionFacts(context: string): string[] {
  const lines = context.replace(/\r\n?/g, "\n").split("\n");
  const facts = lines.filter((line) => /^\d+\.\s+\S/.test(line.trim())).map((line) => line.trim());
  if (!facts.length)
    throw new Error("MemoryAgentBench conflict context contains no numbered facts");
  return facts;
}

function normalizeAnswer(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\b(?:a|an|the)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const anchorStopWords = new Set([
  "are",
  "did",
  "does",
  "from",
  "have",
  "part",
  "that",
  "the",
  "their",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function anchorTerm(term: string): string {
  if (term.length > 5 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

function meaningfulTerms(value: string): Set<string> {
  return new Set(
    normalizeAnswer(value)
      .split(" ")
      .filter((term) => term.length > 2 && !anchorStopWords.has(term))
      .map(anchorTerm),
  );
}

function weightedQueryTerms(value: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const rawTerm of value.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const normalized = normalizeAnswer(rawTerm);
    if (normalized.length <= 2 || anchorStopWords.has(normalized)) continue;
    const term = anchorTerm(normalized);
    const weight = /^\p{Lu}/u.test(rawTerm) ? 2 : 1;
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  }
  return weights;
}

function occurrenceIndexes(value: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + Math.max(1, needle.length);
  }
  return indexes;
}

function answerQueryProximity(
  normalizedChunk: string,
  matchedReferences: string[],
  queryTerms: Map<string, number>,
): number {
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (const reference of matchedReferences) {
    for (const referenceIndex of occurrenceIndexes(normalizedChunk, reference)) {
      const referenceCenter = referenceIndex + reference.length / 2;
      for (const term of queryTerms.keys()) {
        for (const termIndex of occurrenceIndexes(normalizedChunk, term)) {
          const termCenter = termIndex + term.length / 2;
          minimumDistance = Math.min(minimumDistance, Math.abs(referenceCenter - termCenter));
        }
      }
    }
  }
  return Number.isFinite(minimumDistance) ? -minimumDistance : Number.NEGATIVE_INFINITY;
}

export function memoryAgentBenchLiteralAnswerChunkIndex(
  chunks: string[],
  query: string,
  references: string[],
): number | null {
  const normalizedReferences = references
    .map(normalizeAnswer)
    .filter((reference) => reference.length >= 3 || /^\d+$/.test(reference));
  const queryTerms = weightedQueryTerms(query);
  let bestIndex: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestProximity = Number.NEGATIVE_INFINITY;
  for (const [index, chunk] of chunks.entries()) {
    const normalizedChunk = normalizeAnswer(chunk);
    const matchedReferences = normalizedReferences.filter((reference) =>
      normalizedChunk.includes(reference),
    );
    if (!matchedReferences.length) continue;
    const chunkTerms = meaningfulTerms(chunk);
    const queryOverlap = [...queryTerms].reduce(
      (total, [term, weight]) =>
        total + (chunkTerms.has(term) ? weight * Math.min(term.length, 12) : 0),
      0,
    );
    const referenceLength = Math.max(...matchedReferences.map((reference) => reference.length));
    const score = queryOverlap + Math.min(referenceLength, 24);
    const proximity = answerQueryProximity(normalizedChunk, matchedReferences, queryTerms);
    if (score > bestScore || (score === bestScore && proximity > bestProximity)) {
      bestIndex = index;
      bestScore = score;
      bestProximity = proximity;
    }
  }
  return bestIndex;
}

export function memoryAgentBenchLiteralAnswerFactIndexes(
  facts: string[],
  references: string[],
): number[] {
  const normalizedReferences = references.map(normalizeAnswer).filter(Boolean);
  return facts.flatMap((fact, index) => {
    const normalizedFact = normalizeAnswer(fact);
    return normalizedReferences.some((reference) => normalizedFact.includes(reference))
      ? [index]
      : [];
  });
}

export function memoryAgentBenchSubstringExactMatch(
  prediction: string,
  references: string[],
): boolean {
  const normalizedPrediction = normalizeAnswer(prediction);
  return references.some((reference) => normalizedPrediction.includes(normalizeAnswer(reference)));
}

import manifest from "../../evaluation/external/longmemeval.json";
import type { RetrievalBenchmarkPartition } from "../../src/lib/retrieval-benchmark";
import { readJsonArray } from "./json-array";

interface LongMemEvalTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalRecord {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemEvalTurn[][];
}

export interface LongMemEvalAdapterOptions {
  limit?: number;
  maxCases?: number;
  casesPerType?: number;
  questionTypes?: ReadonlySet<string>;
}

export type LongMemEvalSplit = keyof typeof manifest.files;

export const LONGMEMEVAL_QUESTION_TYPES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
] as const;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a string`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function answer(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return text(value, "answer");
}

export function parseLongMemEvalRecord(value: unknown): LongMemEvalRecord {
  const input = object(value, "LongMemEval record");
  if (!Array.isArray(input.haystack_sessions)) {
    throw new Error("haystack_sessions must be an array");
  }
  const record: LongMemEvalRecord = {
    question_id: text(input.question_id, "question_id"),
    question_type: text(input.question_type, "question_type"),
    question: text(input.question, "question"),
    answer: answer(input.answer),
    question_date: text(input.question_date, "question_date"),
    answer_session_ids: stringArray(input.answer_session_ids, "answer_session_ids"),
    haystack_session_ids: stringArray(input.haystack_session_ids, "haystack_session_ids"),
    haystack_dates: stringArray(input.haystack_dates, "haystack_dates"),
    haystack_sessions: input.haystack_sessions.map((session, sessionIndex) => {
      if (!Array.isArray(session)) {
        throw new Error(`haystack_sessions[${sessionIndex}] must be an array`);
      }
      return session.map((rawTurn, turnIndex) => {
        const turn = object(rawTurn, `haystack_sessions[${sessionIndex}][${turnIndex}]`);
        return {
          role: text(turn.role, `haystack_sessions[${sessionIndex}][${turnIndex}].role`),
          content: string(turn.content, `haystack_sessions[${sessionIndex}][${turnIndex}].content`),
          ...(typeof turn.has_answer === "boolean" ? { has_answer: turn.has_answer } : {}),
        };
      });
    }),
  };
  if (
    record.haystack_sessions.length !== record.haystack_session_ids.length ||
    record.haystack_sessions.length !== record.haystack_dates.length
  ) {
    throw new Error(`LongMemEval record ${record.question_id} has misaligned session arrays`);
  }
  const sessionIdCounts = new Map<string, number>();
  for (const sessionId of record.haystack_session_ids) {
    sessionIdCounts.set(sessionId, (sessionIdCounts.get(sessionId) ?? 0) + 1);
  }
  for (const evidenceId of record.answer_session_ids) {
    const occurrenceCount = sessionIdCounts.get(evidenceId) ?? 0;
    if (occurrenceCount === 0) {
      throw new Error(
        `LongMemEval record ${record.question_id} references missing evidence ${evidenceId}`,
      );
    }
    if (occurrenceCount > 1) {
      throw new Error(
        `LongMemEval record ${record.question_id} has ambiguous duplicate evidence ${evidenceId}`,
      );
    }
  }
  return record;
}

function renderSession(date: string, turns: LongMemEvalTurn[]): string {
  return [
    `Conversation session at ${date}`,
    ...turns.filter((turn) => turn.content.trim()).map((turn) => `${turn.role}: ${turn.content}`),
  ]
    .join("\n\n")
    .trim();
}

export function toLongMemEvalPartition(
  record: LongMemEvalRecord,
  options: Pick<LongMemEvalAdapterOptions, "limit"> = {},
): RetrievalBenchmarkPartition {
  const tripwireKey = "__bob_private_tripwire__";
  const sessionOccurrences = new Map<string, number>();
  const sessionOccurrenceByIndex: number[] = [];
  const sessionKeys = record.haystack_session_ids.map((sessionId) => {
    const occurrence = (sessionOccurrences.get(sessionId) ?? 0) + 1;
    sessionOccurrences.set(sessionId, occurrence);
    sessionOccurrenceByIndex.push(occurrence);
    return occurrence === 1 ? sessionId : `${sessionId}::occurrence:${occurrence}`;
  });
  if (new Set(sessionKeys).size !== sessionKeys.length) {
    throw new Error(`LongMemEval record ${record.question_id} cannot disambiguate session ids`);
  }
  return {
    key: record.question_id,
    name: `LongMemEval ${record.question_id}`,
    memories: [
      ...record.haystack_sessions.map((session, index) => ({
        key: sessionKeys[index],
        owner: "alice" as const,
        scope: "private" as const,
        content: renderSession(record.haystack_dates[index], session),
        metadata: {
          benchmark: manifest.name,
          benchmarkVersion: manifest.version,
          questionId: record.question_id,
          sessionId: record.haystack_session_ids[index],
          sessionOccurrence: sessionOccurrenceByIndex[index],
          sessionDate: record.haystack_dates[index],
        },
      })),
      {
        key: tripwireKey,
        owner: "bob",
        scope: "private",
        content: [
          "Confidential private benchmark answer belonging only to Bob.",
          `Question: ${record.question}`,
          `Answer: ${record.answer}`,
        ].join("\n"),
        metadata: {
          benchmark: manifest.name,
          benchmarkVersion: manifest.version,
          questionId: record.question_id,
          isolationTripwire: true,
        },
      },
    ],
    cases: [
      {
        key: record.question_id,
        category: record.question_type,
        query: record.question,
        expectedKeys: record.answer_session_ids,
        forbiddenKeys: [tripwireKey],
        limit: options.limit ?? 5,
      },
    ],
  };
}

export async function* readLongMemEvalPartitions(
  filePath: string,
  options: LongMemEvalAdapterOptions = {},
): AsyncGenerator<RetrievalBenchmarkPartition> {
  const maxCases = options.maxCases ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(maxCases) && maxCases !== Number.POSITIVE_INFINITY) {
    throw new Error("LongMemEval maxCases must be an integer");
  }
  if (maxCases < 1) throw new Error("LongMemEval maxCases must be at least one");
  const casesPerType = options.casesPerType ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(casesPerType) && casesPerType !== Number.POSITIVE_INFINITY) {
    throw new Error("LongMemEval casesPerType must be an integer");
  }
  if (casesPerType < 1) throw new Error("LongMemEval casesPerType must be at least one");
  const selectedTypes =
    options.questionTypes ??
    (Number.isFinite(casesPerType) ? new Set(LONGMEMEVAL_QUESTION_TYPES) : undefined);

  let emitted = 0;
  const seenQuestionIds = new Set<string>();
  const emittedByType = new Map<string, number>();
  for await (const value of readJsonArray(filePath)) {
    const record = parseLongMemEvalRecord(value);
    if (seenQuestionIds.has(record.question_id)) {
      throw new Error(`Duplicate LongMemEval question id ${record.question_id}`);
    }
    seenQuestionIds.add(record.question_id);
    if (selectedTypes && !selectedTypes.has(record.question_type)) continue;
    if ((emittedByType.get(record.question_type) ?? 0) >= casesPerType) continue;
    yield toLongMemEvalPartition(record, options);
    emitted += 1;
    emittedByType.set(record.question_type, (emittedByType.get(record.question_type) ?? 0) + 1);
    if (emitted >= maxCases) break;
    if (
      selectedTypes &&
      Number.isFinite(casesPerType) &&
      [...selectedTypes].every((type) => (emittedByType.get(type) ?? 0) >= casesPerType)
    ) {
      break;
    }
  }
  if (emitted === 0) throw new Error("LongMemEval filters selected no cases");
  if (selectedTypes && Number.isFinite(casesPerType) && emitted < maxCases) {
    const missing = [...selectedTypes].filter(
      (type) => (emittedByType.get(type) ?? 0) < casesPerType,
    );
    if (missing.length) {
      throw new Error(`LongMemEval is missing requested cases for: ${missing.join(", ")}`);
    }
  }
}

export const longMemEvalManifest = manifest;

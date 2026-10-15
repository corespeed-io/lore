import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import {
  LOCOMO_CATEGORY_NAMES,
  LOCOMO_POSITIVE_CATEGORIES,
  LOCOMO_READER_INSTRUCTION,
  type LocomoCategory,
  locomoManifest,
  locomoReaderQuestion,
  parseLocomoSample,
  renderLocomoDialog,
} from "../retrieval/locomo";
import {
  isLongMemEvalAbstention,
  type LongMemEvalRecord,
  longMemEvalManifest,
  parseLongMemEvalRecord,
  toLongMemEvalPartition,
} from "../retrieval/longmemeval";
import { datasetIsVerified, downloadDataset } from "../shared/dataset-download";
import { type FileIntegrity, verifyFile } from "../shared/file-integrity";
import { readJsonArray } from "../shared/json-array";
import type {
  CorpusRecord,
  Dataset,
  DatasetCaseIndex,
  EvalCase,
  EvalUnit,
  SourceRecord,
} from "./types";

/**
 * Verify a pinned dataset file, downloading it first when this checkout has none,
 * so a fresh sandbox needs no separate fetch step. A file that exists but fails
 * its checksum is an error, never silently replaced.
 */
async function pinnedDataset(path: string, file: FileIntegrity, url: string, label: string) {
  if (await datasetIsVerified(path, file)) return;
  process.stderr.write(
    `[eval] downloading ${label} (${file.bytes.toLocaleString("en-US")} bytes)\n`,
  );
  await downloadDataset({ url, outputPath: path, expected: file, label });
}

/**
 * LongMemEval-S: one Unit per question, one record per haystack session (split at
 * turn boundaries past the 32k Memory bound, parts anchored to the session), and
 * the official V1 rubric. Sessions render exactly as the retrieval benchmark does.
 */
export function longMemEvalS(): Dataset {
  const file = longMemEvalManifest.files.s;
  const path = resolve("evaluation/datasets/longmemeval", file.filename);
  const category = (record: LongMemEvalRecord) =>
    isLongMemEvalAbstention(record) ? "abstention" : record.question_type;
  let verified: Promise<void> | undefined;
  const records = async function* () {
    verified ??= pinnedDataset(
      path,
      file,
      `${longMemEvalManifest.source}/resolve/${longMemEvalManifest.revision}/${file.filename}`,
      "LongMemEval s",
    );
    await verified;
    for await (const value of readJsonArray(path)) yield parseLongMemEvalRecord(value);
  };
  return {
    id: "longmemeval-s",
    revision: `${longMemEvalManifest.revision}:${file.sha256}`,
    scorer: "longmemeval-judge-v1",
    // The reader's default instruction and the experiments' 24,000-unit cap.
    reader: { maximumContextCharacters: 24_000 },
    async index() {
      const index: DatasetCaseIndex[] = [];
      for await (const record of records()) {
        index.push({
          id: record.question_id,
          unitKey: record.question_id,
          category: category(record),
        });
      }
      return index;
    },
    async *units(caseIds) {
      for await (const record of records()) {
        if (!caseIds.has(record.question_id)) continue;
        const partition = toLongMemEvalPartition(record);
        const evalCase: EvalCase = {
          id: record.question_id,
          unitKey: record.question_id,
          category: category(record),
          question: record.question,
          readerQuestion: `Question time: ${record.question_date}\n${record.question}`,
          searchQuery: record.question,
          answer: String(record.answer),
          evidenceKeys: isLongMemEvalAbstention(record) ? [] : record.answer_session_ids,
          abstention: isLongMemEvalAbstention(record),
          scoring: { questionType: record.question_type },
        };
        const unit: EvalUnit = {
          key: record.question_id,
          records: partition.memories
            .filter((memory) => memory.owner === "alice")
            .map(
              (memory): CorpusRecord => ({
                key: memory.key,
                text: memory.content,
                ...(memory.anchorKey ? { anchorKey: memory.anchorKey } : {}),
              }),
            ),
          cases: [evalCase],
          tripwires: partition.memories
            .filter((memory) => memory.owner === "bob")
            .map((memory) => memory.content),
        };
        yield unit;
      }
    },
  };
}

/**
 * The fact Memories the frozen LongMemEval-S corpus holds: one per session Memory,
 * written by one extractor model under one instruction. They are exported once,
 * read-only, from that database on the eval server, and pinned by digest, so every
 * sandbox reads the same facts.
 */
export const LONGMEMEVAL_FACTS = {
  corpus: "longmemeval-facts-v1",
  database: "lore_longmemeval_bench_1536",
  extractorModel: "gemini-3.5-flash-lite",
  extractorInstructionSha256: "0eec0caf88dce26c4c3239b43bd3fc821c35ac336be02750508f837e0856efa7",
  path: "evaluation/datasets/longmemeval/longmemeval-s-facts-v1.jsonl",
  file: {
    bytes: 32_210_825,
    sha256: "91f19ef5b7f3b1f712cc2442e75155b961fff8419aaf6cd3e5641bfdfbe3b69e",
  },
} as const;

/**
 * The frozen corpus also extracted a "fact" from Bob's private tripwire Memory in
 * every question. It restates the gold answer, so it is never an Alice record.
 */
const LONGMEMEVAL_TRIPWIRE_KEY = "__bob_private_tripwire__";

interface LongMemEvalFact {
  questionId: string;
  /** The session Memory key the fact was extracted from (a part key for split sessions). */
  key: string;
  text: string;
}

/** Export the pinned facts from the frozen corpus, read-only, and check their digest. */
async function exportLongMemEvalFacts(path: string): Promise<void> {
  const server = process.env.LORE_EVAL_SERVER_URL?.trim();
  if (!server) {
    throw new Error(`${path} is missing; LORE_EVAL_SERVER_URL is needed to export it`);
  }
  const url = new URL(server);
  url.pathname = `/${LONGMEMEVAL_FACTS.database}`;
  const client = new pg.Client({
    connectionString: url.toString(),
    options: "-c default_transaction_read_only=on -c statement_timeout=300000",
  });
  await client.connect();
  try {
    const { rows } = await client.query<LongMemEvalFact>(
      `SELECT metadata->>'questionId' AS "questionId", metadata->>'benchmarkKey' AS key,
         content AS text
       FROM memories
       WHERE metadata->>'factsCorpus' = $1 AND metadata->>'extractorModel' = $2
         AND metadata->>'extractorInstructionSha256' = $3
       ORDER BY metadata->>'questionId' COLLATE "C", metadata->>'benchmarkKey' COLLATE "C"`,
      [
        LONGMEMEVAL_FACTS.corpus,
        LONGMEMEVAL_FACTS.extractorModel,
        LONGMEMEVAL_FACTS.extractorInstructionSha256,
      ],
    );
    mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    const lines = rows.map((row) =>
      JSON.stringify({ questionId: row.questionId, key: row.key, text: row.text }),
    );
    writeFileSync(partial, `${lines.join("\n")}\n`);
    await verifyFile(partial, LONGMEMEVAL_FACTS.file);
    renameSync(partial, path);
  } finally {
    await client.end();
  }
}

/** "2023/05/20 (Sat) 02:21" as RFC 3339 UTC, the haystack's own clock. */
export function longMemEvalSessionTime(value: string): string {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Unexpected LongMemEval session date ${value}`);
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:00.000Z`;
}

/**
 * LongMemEval-S as fact Memories with their sources: one Unit per question, one
 * record per extracted fact, each citing the whole session it came from, and each
 * session as one source. Questions, cases, tiers, tripwires, and the rubric are
 * LongMemEval-S's. The citation is the fact's own provenance, as a production
 * Memory's would be; the gold answer sessions are used only to score retrieval.
 */
export function longMemEvalSFacts(): Dataset {
  const base = longMemEvalS();
  const path = resolve(LONGMEMEVAL_FACTS.path);
  let loaded: Promise<Map<string, LongMemEvalFact[]>> | undefined;
  const facts = () =>
    (loaded ??= (async () => {
      if (!(await datasetIsVerified(path, LONGMEMEVAL_FACTS.file))) {
        process.stderr.write(`[eval] exporting ${LONGMEMEVAL_FACTS.corpus} read-only\n`);
        await exportLongMemEvalFacts(path);
      }
      const byQuestion = new Map<string, LongMemEvalFact[]>();
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const fact = JSON.parse(line) as LongMemEvalFact;
        const list = byQuestion.get(fact.questionId) ?? [];
        list.push(fact);
        byQuestion.set(fact.questionId, list);
      }
      return byQuestion;
    })());
  return {
    id: "longmemeval-s-facts",
    revision: `${base.revision}:${LONGMEMEVAL_FACTS.corpus}:${LONGMEMEVAL_FACTS.file.sha256}`,
    scorer: base.scorer,
    // Room for a full search (10 Memories) plus a full default source read (24,000),
    // so the reader sees every item of either layout and only their order differs.
    reader: { maximumContextCharacters: 60_000 },
    index: () => base.index(),
    async *units(caseIds) {
      const byQuestion = await facts();
      for await (const unit of base.units(caseIds)) {
        // A session's parts join back into the whole session, its one source.
        const sessionOf = new Map<string, string>();
        const texts = new Map<string, string>();
        for (const record of unit.records) {
          const session = record.anchorKey ?? record.key;
          sessionOf.set(record.key, session);
          texts.set(session, (texts.get(session) ?? "") + record.text);
        }
        const sources: SourceRecord[] = [...texts].map(([key, text]) => {
          const header = /^Conversation session at (.+)\n/.exec(text)?.[1];
          if (!header) throw new Error(`${unit.key}: session ${key} has no date line`);
          return { key, text, observedAt: longMemEvalSessionTime(header) };
        });
        const unitFacts = (byQuestion.get(unit.key) ?? []).filter(
          (fact) => fact.key !== LONGMEMEVAL_TRIPWIRE_KEY,
        );
        // Exactly one fact per session Memory, no more and no fewer.
        const factKeys = new Set(unitFacts.map((fact) => fact.key));
        if (
          factKeys.size !== unitFacts.length ||
          factKeys.size !== sessionOf.size ||
          [...sessionOf.keys()].some((key) => !factKeys.has(key))
        ) {
          throw new Error(
            `${unit.key}: ${unitFacts.length} facts do not match ${sessionOf.size} session Memories`,
          );
        }
        const records: CorpusRecord[] = unitFacts.map((fact) => {
          const session = sessionOf.get(fact.key);
          if (!session) throw new Error(`${unit.key}: fact ${fact.key} names no session`);
          return {
            key: fact.key,
            text: fact.text,
            ...(session === fact.key ? {} : { anchorKey: session }),
            cites: [session],
          };
        });
        yield { ...unit, records, sources } satisfies EvalUnit;
      }
    },
  };
}

/**
 * LoCoMo categories 1-4: one Unit per conversation, one record per dialog turn,
 * and the paper's token F1. Category 5 is excluded, as in Lore's canonical profile.
 */
export function locomo(): Dataset {
  const file = locomoManifest.files.dataset;
  const path = resolve("evaluation/datasets/locomo", file.filename);
  let loaded: Promise<ReturnType<typeof parseLocomoSample>[]> | undefined;
  const samples = () =>
    (loaded ??= pinnedDataset(
      path,
      file,
      `https://raw.githubusercontent.com/snap-research/locomo/${locomoManifest.revision}/${file.path}`,
      "LoCoMo (CC BY-NC 4.0)",
    ).then(() => (JSON.parse(readFileSync(path, "utf8")) as unknown[]).map(parseLocomoSample)));
  const positive = (value: LocomoCategory) =>
    (LOCOMO_POSITIVE_CATEGORIES as readonly LocomoCategory[]).includes(value);
  const caseId = (sampleId: string, key: string) => `locomo:${sampleId}:${key}`;
  return {
    id: "locomo",
    revision: `${locomoManifest.revision}:${file.sha256}`,
    scorer: "locomo-f1",
    // Token F1 is continuous and noisier than a yes/no rubric, so the sample is larger.
    tierSizes: { standard: 50 },
    reader: { instruction: LOCOMO_READER_INSTRUCTION, maximumContextCharacters: 24_000 },
    async index() {
      return (await samples()).flatMap((sample) =>
        sample.questions
          .filter((question) => positive(question.category))
          .map((question) => ({
            id: caseId(sample.id, question.key),
            unitKey: sample.id,
            category: LOCOMO_CATEGORY_NAMES[question.category],
          })),
      );
    },
    async *units(caseIds) {
      for (const sample of await samples()) {
        const questions = sample.questions.filter(
          (question) => positive(question.category) && caseIds.has(caseId(sample.id, question.key)),
        );
        if (!questions.length) continue;
        yield {
          key: sample.id,
          records: sample.sessions.flatMap((session) =>
            session.dialogs.map((dialog) => ({
              key: dialog.id,
              text: renderLocomoDialog(session, dialog),
            })),
          ),
          cases: questions.map((question) => ({
            id: caseId(sample.id, question.key),
            unitKey: sample.id,
            category: LOCOMO_CATEGORY_NAMES[question.category],
            question: question.question,
            readerQuestion: locomoReaderQuestion(question),
            searchQuery: question.question,
            answer: String(question.answer),
            evidenceKeys: [...new Set(question.evidence)],
            abstention: false,
            scoring: { locomoCategory: question.category },
          })),
          tripwires: questions.map((question) =>
            [
              "Confidential private LoCoMo benchmark answer belonging only to Bob.",
              `Question: ${question.question}`,
              `Answer: ${String(question.answer)}`,
            ].join("\n"),
          ),
        };
      }
    },
  };
}

export const DATASETS = {
  "longmemeval-s": longMemEvalS,
  "longmemeval-s-facts": longMemEvalSFacts,
  locomo,
} as const;
export type DatasetName = keyof typeof DATASETS;
export function isDatasetName(value: string): value is DatasetName {
  return Object.hasOwn(DATASETS, value);
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { verifyFile } from "../shared/file-integrity";
import { readJsonArray } from "../shared/json-array";
import type { CorpusRecord, Dataset, DatasetCaseIndex, EvalCase, EvalUnit } from "./types";

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
    verified ??= verifyFile(path, file);
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
 * LoCoMo categories 1-4: one Unit per conversation, one record per dialog turn,
 * and the paper's token F1. Category 5 is excluded, as in Lore's canonical profile.
 */
export function locomo(): Dataset {
  const file = locomoManifest.files.dataset;
  const path = resolve("evaluation/datasets/locomo", file.filename);
  let loaded: Promise<ReturnType<typeof parseLocomoSample>[]> | undefined;
  const samples = () =>
    (loaded ??= verifyFile(path, file).then(() =>
      (JSON.parse(readFileSync(path, "utf8")) as unknown[]).map(parseLocomoSample),
    ));
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

export const DATASETS = { "longmemeval-s": longMemEvalS, locomo } as const;
export type DatasetName = keyof typeof DATASETS;
export function isDatasetName(value: string): value is DatasetName {
  return Object.hasOwn(DATASETS, value);
}

import { readFile } from "node:fs/promises";
import manifest from "../../evaluation/external/longmemeval-v2.json";
import { chunkMemoryContent } from "../../src/lib/memory-chunking";
import {
  MAX_EPISODE_CONTENT_CHARACTERS,
  MAX_EPISODE_OBSERVATIONS,
  MAX_OBSERVATION_CONTENT_CHARACTERS,
  type RecordEpisode,
} from "../../src/lib/observations";
import { readJsonLines } from "./json-lines";

export interface LongMemEvalV2Question {
  id: string;
  domain: "web" | "enterprise";
  environment: string;
  questionType: string;
  question: string;
  image: string | null;
  answer: string;
  evaluator: string;
}

export interface LongMemEvalV2State {
  stateIndex: number;
  step: number | null;
  url: string;
  action: string | null;
  thought: string | null;
  accessibilityTree: string;
  screenshot: string | null;
}

export interface LongMemEvalV2Trajectory {
  id: string;
  domain: "web" | "enterprise";
  environment: string;
  goal: string;
  outcome: "success" | "failure";
  startUrl: string;
  states: LongMemEvalV2State[];
}

export interface LongMemEvalV2SelectionOptions {
  maxCases: number;
  deterministicOnly?: boolean;
  textOnly?: boolean;
  questionTypes?: ReadonlySet<string>;
}

export interface LongMemEvalV2QuestionScreenshot {
  path: string;
  bytes: number;
  sha256: string;
  mimeType: "image/png";
}

export interface LongMemEvalV2ScreenshotDimensions {
  width: number;
  height: number;
}

export interface LongMemEvalV2EpisodePlan {
  episodes: RecordEpisode[];
  renderedContent: string;
  observationCount: number;
}

export const LONGMEMEVAL_V2_EPISODE_PLAN_REVISION = "lore-longmemeval-v2-episode-plan-v1";
const maximumObservationFragmentCodePoints = Math.floor(MAX_OBSERVATION_CONTENT_CHARACTERS / 2);

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const;

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

function optionalText(value: unknown, path: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, path);
}

export function parseLongMemEvalV2Question(value: unknown): LongMemEvalV2Question {
  const row = object(value, "LongMemEval-V2 question");
  const domain = text(row.domain, "question.domain");
  if (domain !== "web" && domain !== "enterprise") {
    throw new Error("question.domain must be web or enterprise");
  }
  return {
    id: text(row.id, "question.id"),
    domain,
    environment: text(row.environment, "question.environment"),
    questionType: text(row.question_type, "question.question_type"),
    question: text(row.question, "question.question"),
    image: optionalText(row.image, "question.image"),
    answer: text(row.answer, "question.answer"),
    evaluator: text(row.eval_function, "question.eval_function"),
  };
}

export function parseLongMemEvalV2Trajectory(value: unknown): LongMemEvalV2Trajectory {
  const row = object(value, "LongMemEval-V2 trajectory");
  const domain = text(row.domain, "trajectory.domain");
  if (domain !== "web" && domain !== "enterprise") {
    throw new Error("trajectory.domain must be web or enterprise");
  }
  const outcome = text(row.outcome, "trajectory.outcome");
  if (outcome !== "success" && outcome !== "failure") {
    throw new Error("trajectory.outcome must be success or failure");
  }
  if (!Array.isArray(row.states)) throw new Error("trajectory.states must be an array");
  return {
    id: text(row.id, "trajectory.id"),
    domain,
    environment: text(row.environment, "trajectory.environment"),
    goal: text(row.goal, "trajectory.goal"),
    outcome,
    startUrl: text(row.start_url, "trajectory.start_url"),
    states: row.states.map((value, index) => {
      const state = object(value, `trajectory.states[${index}]`);
      if (!Number.isInteger(state.state_index) || (state.state_index as number) < 0) {
        throw new Error(`trajectory.states[${index}].state_index must be non-negative`);
      }
      if (state.step !== null && state.step !== undefined && !Number.isInteger(state.step)) {
        throw new Error(`trajectory.states[${index}].step must be an integer or null`);
      }
      return {
        stateIndex: state.state_index as number,
        step: (state.step as number | null | undefined) ?? null,
        url: text(state.url, `trajectory.states[${index}].url`),
        action: optionalText(state.action, `trajectory.states[${index}].action`),
        thought: optionalText(state.thought, `trajectory.states[${index}].thought`),
        accessibilityTree:
          optionalText(
            state.accessibility_tree,
            `trajectory.states[${index}].accessibility_tree`,
          ) ?? "",
        screenshot: optionalText(state.screenshot, `trajectory.states[${index}].screenshot`),
      };
    }),
  };
}

function longMemEvalV2TrajectorySections(trajectory: LongMemEvalV2Trajectory): Array<{
  content: string;
  stateIndex: number | null;
}> {
  const header = [
    `Trajectory ${trajectory.id}`,
    `Environment: ${trajectory.environment}`,
    `Goal: ${trajectory.goal}`,
    `Outcome: ${trajectory.outcome}`,
  ].join("\n\n");
  const states = trajectory.states.flatMap((state) => {
    const fields = [
      `State ${state.stateIndex}`,
      `URL: ${state.url}`,
      state.action ? `Action: ${state.action}` : null,
      state.thought ? `Thought: ${state.thought}` : null,
      state.accessibilityTree ? `Observation:\n${state.accessibilityTree}` : null,
    ].filter((field): field is string => field !== null);
    return fields.length > 1 ? [{ content: fields.join("\n"), stateIndex: state.stateIndex }] : [];
  });
  return [{ content: header, stateIndex: null }, ...states];
}

export function renderLongMemEvalV2Trajectory(trajectory: LongMemEvalV2Trajectory): string {
  return longMemEvalV2TrajectorySections(trajectory)
    .map((section) => section.content)
    .join("\n\n");
}

export function planLongMemEvalV2TrajectoryEpisodes(
  trajectory: LongMemEvalV2Trajectory,
  metadata: Record<string, unknown>,
): LongMemEvalV2EpisodePlan {
  const sections = longMemEvalV2TrajectorySections(trajectory);
  const renderedContent = sections.map((section) => section.content).join("\n\n");
  let segmentOrdinal = 0;
  const observations = sections.flatMap((section, sectionOrdinal) => {
    const exactSection = sectionOrdinal === 0 ? section.content : `\n\n${section.content}`;
    return chunkMemoryContent(exactSection, maximumObservationFragmentCodePoints).map(
      (content, fragmentOrdinal) => ({
        kind: "event" as const,
        content,
        metadata: {
          ...metadata,
          recordType: "trajectory-evidence",
          trajectoryId: trajectory.id,
          segmentOrdinal: segmentOrdinal++,
          stateIndex: section.stateIndex,
          fragmentOrdinal,
        },
      }),
    );
  });
  const episodes: RecordEpisode[] = [];
  let current: Array<RecordEpisode["observations"][number]> = [];
  let currentCharacters = 0;
  for (const observation of observations) {
    if (
      current.length >= MAX_EPISODE_OBSERVATIONS ||
      currentCharacters + observation.content.length > MAX_EPISODE_CONTENT_CHARACTERS
    ) {
      episodes.push({
        kind: "workflow",
        scope: "private",
        observations: current.map((item) => ({
          ...item,
          metadata: { ...item.metadata, trajectoryEpisodeOrdinal: episodes.length },
        })),
      });
      current = [];
      currentCharacters = 0;
    }
    current.push(observation);
    currentCharacters += observation.content.length;
  }
  if (current.length) {
    episodes.push({
      kind: "workflow",
      scope: "private",
      observations: current.map((item) => ({
        ...item,
        metadata: { ...item.metadata, trajectoryEpisodeOrdinal: episodes.length },
      })),
    });
  }
  if (episodes.length === 0) throw new Error("LongMemEval-V2 trajectory produced no evidence");
  return { episodes, renderedContent, observationCount: observations.length };
}

function normalizeLiteralAnchor(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\b(?:a|an|the)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function longMemEvalV2ContainsLiteralAnswer(text: string, answer: string): boolean {
  const normalizedAnswer = normalizeLiteralAnchor(answer);
  if (normalizedAnswer.length < 3) return false;
  return normalizeLiteralAnchor(text).includes(normalizedAnswer);
}

export async function readLongMemEvalV2Questions(
  filePath: string,
): Promise<LongMemEvalV2Question[]> {
  const questions: LongMemEvalV2Question[] = [];
  const ids = new Set<string>();
  for await (const value of readJsonLines(filePath)) {
    const question = parseLongMemEvalV2Question(value);
    if (ids.has(question.id)) throw new Error(`Duplicate LongMemEval-V2 question ${question.id}`);
    ids.add(question.id);
    questions.push(question);
  }
  return questions;
}

export async function readLongMemEvalV2Haystack(filePath: string): Promise<Map<string, string[]>> {
  const payload = object(JSON.parse(await readFile(filePath, "utf8")), "LongMemEval-V2 haystack");
  return new Map(
    Object.entries(payload).map(([questionId, value]) => {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
        throw new Error(`Haystack ${questionId} must contain trajectory ids`);
      }
      if (new Set(value).size !== value.length) {
        throw new Error(`Haystack ${questionId} contains duplicate trajectory ids`);
      }
      return [questionId, value as string[]];
    }),
  );
}

export async function readSelectedLongMemEvalV2Trajectories(
  filePath: string,
  selectedIds: ReadonlySet<string>,
): Promise<Map<string, LongMemEvalV2Trajectory>> {
  const trajectories = new Map<string, LongMemEvalV2Trajectory>();
  for await (const trajectory of streamSelectedLongMemEvalV2Trajectories(filePath, selectedIds)) {
    trajectories.set(trajectory.id, trajectory);
  }
  return trajectories;
}

export async function* streamSelectedLongMemEvalV2Trajectories(
  filePath: string,
  selectedIds: ReadonlySet<string>,
): AsyncGenerator<LongMemEvalV2Trajectory> {
  const remaining = new Set(selectedIds);
  const seen = new Set<string>();
  for await (const value of readJsonLines(filePath)) {
    const raw = object(value, "LongMemEval-V2 trajectory");
    if (typeof raw.id !== "string" || !selectedIds.has(raw.id)) continue;
    const trajectory = parseLongMemEvalV2Trajectory(raw);
    if (seen.has(trajectory.id)) {
      throw new Error(`Duplicate LongMemEval-V2 trajectory ${trajectory.id}`);
    }
    seen.add(trajectory.id);
    remaining.delete(trajectory.id);
    yield trajectory;
    if (!remaining.size) break;
  }
  if (remaining.size) {
    throw new Error(
      `Missing LongMemEval-V2 trajectories: ${[...remaining].slice(0, 10).join(", ")}`,
    );
  }
}

export function selectLongMemEvalV2Questions(
  questions: LongMemEvalV2Question[],
  options: LongMemEvalV2SelectionOptions,
): LongMemEvalV2Question[] {
  if (!Number.isInteger(options.maxCases) || options.maxCases < 1) {
    throw new Error("LongMemEval-V2 maxCases must be a positive integer");
  }
  const eligible = questions.filter(
    (question) =>
      (!options.deterministicOnly || !question.evaluator.startsWith("llm_")) &&
      (!options.textOnly || question.image === null) &&
      (!options.questionTypes || options.questionTypes.has(question.questionType)),
  );
  if (!eligible.length) throw new Error("LongMemEval-V2 filters selected no questions");
  const byType = new Map<string, LongMemEvalV2Question[]>();
  for (const question of eligible) {
    const group = byType.get(question.questionType) ?? [];
    group.push(question);
    byType.set(question.questionType, group);
  }
  const types = [...byType.keys()].sort();
  const selected: LongMemEvalV2Question[] = [];
  for (let offset = 0; selected.length < options.maxCases; offset += 1) {
    let advanced = false;
    for (const type of types) {
      const question = byType.get(type)?.[offset];
      if (!question) continue;
      selected.push(question);
      advanced = true;
      if (selected.length >= options.maxCases) break;
    }
    if (!advanced) break;
  }
  return selected;
}

export function mapLongMemEvalV2TrajectoryQuestions(
  questions: LongMemEvalV2Question[],
  haystacks: ReadonlyMap<string, string[]>,
): Map<string, Set<string>> {
  const trajectoryQuestions = new Map<string, Set<string>>();
  for (const question of questions) {
    const trajectoryIds = haystacks.get(question.id);
    if (!trajectoryIds) throw new Error(`Missing LongMemEval-V2 haystack for ${question.id}`);
    for (const trajectoryId of trajectoryIds) {
      const questionIds = trajectoryQuestions.get(trajectoryId) ?? new Set<string>();
      questionIds.add(question.id);
      trajectoryQuestions.set(trajectoryId, questionIds);
    }
  }
  return trajectoryQuestions;
}

export function longMemEvalV2QuestionScreenshot(
  imagePath: string | null,
): LongMemEvalV2QuestionScreenshot | undefined {
  if (imagePath === null) return undefined;
  const file = longMemEvalV2Manifest.questionScreenshots.find(
    (candidate) => candidate.path === imagePath,
  );
  if (!file) {
    throw new Error(`LongMemEval-V2 question image is not pinned: ${imagePath}`);
  }
  if (file.mimeType !== "image/png") {
    throw new Error(`LongMemEval-V2 question image has an unsupported MIME type: ${imagePath}`);
  }
  return { ...file, mimeType: "image/png" };
}

export function validateLongMemEvalV2QuestionScreenshot(
  bytes: Uint8Array,
  file: LongMemEvalV2QuestionScreenshot,
): LongMemEvalV2ScreenshotDimensions {
  const format = longMemEvalV2Manifest.questionScreenshotFormat;
  if (bytes.byteLength !== file.bytes || bytes.byteLength > format.maximumBytes) {
    throw new Error(`LongMemEval-V2 question image has an invalid size: ${file.path}`);
  }
  if (
    bytes.byteLength < 24 ||
    pngSignature.some((value, index) => bytes[index] !== value) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  ) {
    throw new Error(`LongMemEval-V2 question image is not a valid PNG: ${file.path}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width !== format.width || height !== format.height) {
    throw new Error(`LongMemEval-V2 question image has invalid dimensions: ${file.path}`);
  }
  return { width, height };
}

export const longMemEvalV2Manifest = manifest;

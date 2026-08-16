import { expect, test } from "vitest";
import { MEMORY_CONTENT_LIMITS, prepareMemoryContent } from "@/lib/memory-content";
import {
  MAX_EPISODE_CONTENT_CHARACTERS,
  MAX_EPISODE_OBSERVATIONS,
  MAX_OBSERVATION_CONTENT_CHARACTERS,
} from "@/lib/observations";
import {
  longMemEvalV2ContainsLiteralAnswer,
  longMemEvalV2QuestionScreenshot,
  mapLongMemEvalV2TrajectoryQuestions,
  parseLongMemEvalV2Question,
  parseLongMemEvalV2Trajectory,
  planLongMemEvalV2TrajectoryEpisodes,
  renderLongMemEvalV2Trajectory,
  selectLongMemEvalV2Questions,
  validateLongMemEvalV2QuestionScreenshot,
} from "../scripts/lib/longmemeval-v2";

test("LongMemEval-V2 parser validates and normalizes official question fields", () => {
  expect(
    parseLongMemEvalV2Question({
      id: "question-1",
      domain: "enterprise",
      environment: "workarena",
      question_type: "procedure",
      question: "Which module comes first?",
      image: null,
      answer: "Reports;Problems",
      eval_function: "norm_phrase_set_match_ordered|separators=;",
    }),
  ).toEqual({
    id: "question-1",
    domain: "enterprise",
    environment: "workarena",
    questionType: "procedure",
    question: "Which module comes first?",
    image: null,
    answer: "Reports;Problems",
    evaluator: "norm_phrase_set_match_ordered|separators=;",
  });
});

test("LongMemEval-V2 trajectories render textual state, action, and observation evidence", () => {
  const trajectory = parseLongMemEvalV2Trajectory({
    id: "trajectory-1",
    domain: "web",
    environment: "shopping",
    goal: "Buy the red notebook",
    outcome: "success",
    start_url: "https://shop.example/",
    states: [
      {
        state_index: 0,
        step: 1,
        url: "https://shop.example/notebooks",
        action: "click Red notebook",
        thought: "This matches the requested color",
        accessibility_tree: "button Red notebook",
        screenshot: "screenshots/trajectory-1/1.png",
      },
    ],
  });

  expect(renderLongMemEvalV2Trajectory(trajectory)).toContain(
    "Goal: Buy the red notebook\n\nOutcome: success",
  );
  expect(renderLongMemEvalV2Trajectory(trajectory)).toContain("Action: click Red notebook");
  expect(renderLongMemEvalV2Trajectory(trajectory)).toContain("Observation:\nbutton Red notebook");
  expect(
    longMemEvalV2ContainsLiteralAnswer(renderLongMemEvalV2Trajectory(trajectory), "Red notebook"),
  ).toBe(true);
  expect(longMemEvalV2ContainsLiteralAnswer(renderLongMemEvalV2Trajectory(trajectory), "A")).toBe(
    false,
  );
});

test("LongMemEval-V2 trajectories cannot bypass the canonical Memory content boundary", () => {
  const trajectory = parseLongMemEvalV2Trajectory({
    id: "oversized-trajectory",
    domain: "web",
    environment: "shopping",
    goal: "Exercise the benchmark ingestion boundary",
    outcome: "success",
    start_url: "https://shop.example/",
    states: [
      {
        state_index: 0,
        step: 1,
        url: "https://shop.example/large-state",
        action: "observe",
        thought: null,
        accessibility_tree: "x".repeat(MEMORY_CONTENT_LIMITS.maximumCharacters + 1),
        screenshot: null,
      },
    ],
  });
  const content = renderLongMemEvalV2Trajectory(trajectory);

  expect(Array.from(content).length).toBeGreaterThan(MEMORY_CONTENT_LIMITS.maximumCharacters);
  expect(() => prepareMemoryContent(content)).toThrow(
    `Memory content may contain at most ${MEMORY_CONTENT_LIMITS.maximumCharacters} Unicode characters`,
  );
});

test("LongMemEval-V2 trajectories become bounded ordered Episode evidence with exact reconstruction", () => {
  const trajectory = parseLongMemEvalV2Trajectory({
    id: "large-trajectory",
    domain: "enterprise",
    environment: "workarena",
    goal: "Preserve a large workflow",
    outcome: "failure",
    start_url: "https://enterprise.example/",
    states: [
      {
        state_index: 7,
        step: 8,
        url: "https://enterprise.example/large-state",
        action: "inspect",
        thought: "Keep state identity while fragmenting evidence",
        accessibility_tree: `start ${"large state node ".repeat(70_000)} ${"😀".repeat(60_000)} end`,
        screenshot: null,
      },
    ],
  });
  const plan = planLongMemEvalV2TrajectoryEpisodes(trajectory, {
    benchmark: "LongMemEval-V2",
    corpusKey: "fixture",
  });
  const observations = plan.episodes.flatMap((episode) => episode.observations);

  expect(plan.renderedContent).toBe(renderLongMemEvalV2Trajectory(trajectory));
  expect(observations.map((observation) => observation.content).join("")).toBe(
    plan.renderedContent,
  );
  expect(plan.episodes.length).toBeGreaterThan(1);
  expect(plan.observationCount).toBe(observations.length);
  expect(
    plan.episodes.every(
      (episode) =>
        episode.observations.length <= MAX_EPISODE_OBSERVATIONS &&
        episode.observations.reduce(
          (total, observation) => total + observation.content.length,
          0,
        ) <= MAX_EPISODE_CONTENT_CHARACTERS,
    ),
  ).toBe(true);
  expect(
    observations.every(
      (observation) => observation.content.length <= MAX_OBSERVATION_CONTENT_CHARACTERS,
    ),
  ).toBe(true);
  expect(observations.map((observation) => observation.metadata?.segmentOrdinal)).toEqual(
    observations.map((_, index) => index),
  );
  for (const [episodeOrdinal, episode] of plan.episodes.entries()) {
    expect(
      episode.observations.every(
        (observation) => observation.metadata?.trajectoryEpisodeOrdinal === episodeOrdinal,
      ),
    ).toBe(true);
  }
  expect(observations.at(-1)?.metadata).toMatchObject({
    trajectoryId: "large-trajectory",
    stateIndex: 7,
  });
});

test("LongMemEval-V2 parser rejects cross-schema domain values", () => {
  expect(() =>
    parseLongMemEvalV2Question({
      id: "bad",
      domain: "mobile",
      environment: "x",
      question_type: "x",
      question: "x",
      image: null,
      answer: "x",
      eval_function: "mc_choice_match",
    }),
  ).toThrow("question.domain must be web or enterprise");
});

test("LongMemEval-V2 pins every supported question screenshot", () => {
  expect(longMemEvalV2QuestionScreenshot("question_screenshots/626e401e.png")).toMatchObject({
    bytes: 140570,
    mimeType: "image/png",
  });
  expect(() => longMemEvalV2QuestionScreenshot("question_screenshots/unpinned.png")).toThrow(
    "question image is not pinned",
  );
});

test("LongMemEval-V2 validates PNG signature and dimensions before reader use", () => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1280, false);
  view.setUint32(20, 720, false);
  const file = {
    path: "question_screenshots/test.png",
    bytes: bytes.byteLength,
    sha256: "fixture",
    mimeType: "image/png" as const,
  };

  expect(validateLongMemEvalV2QuestionScreenshot(bytes, file)).toEqual({
    width: 1280,
    height: 720,
  });
  view.setUint32(20, 719, false);
  expect(() => validateLongMemEvalV2QuestionScreenshot(bytes, file)).toThrow("invalid dimensions");
});

test("LongMemEval-V2 selection is stratified and maps shared trajectories once", () => {
  const question = (id: string, questionType: string, evaluator = "mc_choice_match") => ({
    id,
    domain: "web" as const,
    environment: "browser",
    questionType,
    question: `Question ${id}`,
    image: null,
    answer: "A",
    evaluator,
  });
  const selected = selectLongMemEvalV2Questions(
    [
      question("a1", "alpha"),
      question("a2", "alpha"),
      question("b1", "beta"),
      question("judge", "beta", "llm_abstention_checker"),
    ],
    { maxCases: 3, deterministicOnly: true, textOnly: true },
  );
  expect(selected.map((item) => item.id)).toEqual(["a1", "b1", "a2"]);

  const mapped = mapLongMemEvalV2TrajectoryQuestions(
    selected,
    new Map([
      ["a1", ["shared", "alpha-only"]],
      ["b1", ["shared", "beta-only"]],
      ["a2", ["shared"]],
    ]),
  );
  expect([...(mapped.get("shared") ?? [])].sort()).toEqual(["a1", "a2", "b1"]);
  expect(mapped.size).toBe(3);
});

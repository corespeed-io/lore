import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  evaluateLocomoAnswer,
  normalizeLocomoAnswer,
  parseLocomoSample,
  readLocomoPartitions,
  renderLocomoDialog,
  toLocomoPartition,
} from "../scripts/lib/locomo";
import { nltkPorterStem } from "../scripts/lib/nltk-porter-stemmer";

const fixture = {
  sample_id: "conv-fixture",
  conversation: {
    speaker_a: "Alice",
    speaker_b: "Bob",
    session_1_date_time: "1 January 2026",
    session_1: [
      { speaker: "Alice", dia_id: "D1:1", text: "I adopted two cats." },
      {
        speaker: "Bob",
        dia_id: "D1:2",
        text: "Here is the picture.",
        blip_caption: "two cats sleeping",
      },
    ],
    session_2_date_time: "2 February 2026",
    session_2: [{ speaker: "Alice", dia_id: "D2:1", text: "Their names are Ada and Grace." }],
  },
  qa: [
    {
      question: "What are Alice's cats called?",
      answer: "Ada, Grace",
      evidence: ["D2:1"],
      category: 1,
    },
    {
      question: "When did Alice adopt the cats?",
      answer: "1 January 2026",
      evidence: ["D1:1"],
      category: 2,
    },
    {
      question: "What breed are Alice's cats?",
      answer: null,
      evidence: ["D1:1"],
      category: 5,
    },
  ],
};

test("LoCoMo parses sessions chronologically and preserves dialog evidence ids", () => {
  const sample = parseLocomoSample(fixture);
  expect(sample).toMatchObject({
    id: "conv-fixture",
    speakerA: "Alice",
    speakerB: "Bob",
    sessions: [
      { number: 1, dateTime: "1 January 2026" },
      { number: 2, dateTime: "2 February 2026" },
    ],
    questions: [
      { key: "qa-0001", category: 1, evidence: ["D2:1"] },
      { key: "qa-0002", category: 2, evidence: ["D1:1"] },
      { key: "qa-0003", category: 5, evidence: ["D1:1"] },
    ],
  });
  expect(renderLocomoDialog(sample.sessions[0], sample.sessions[0].dialogs[1])).toContain(
    'Bob said, "Here is the picture." and shared two cats sleeping',
  );
});

test("LoCoMo preserves and repairs the release's compound evidence-id form", () => {
  const sample = parseLocomoSample({
    ...fixture,
    qa: [{ ...fixture.qa[0], evidence: ["D1:1; D2:1"] }],
  });
  expect(sample.questions[0].rawEvidence).toEqual(["D1:1; D2:1"]);
  expect(sample.questions[0].evidence).toEqual(["D1:1", "D2:1"]);
});

test("LoCoMo becomes a dialog-granularity isolated retrieval partition", () => {
  const sample = parseLocomoSample(fixture);
  const partition = toLocomoPartition(sample, sample.questions.slice(0, 2));
  expect(partition.memories).toHaveLength(5);
  expect(partition.memories[0]).toMatchObject({
    key: "D1:1",
    owner: "alice",
    scope: "private",
  });
  expect(partition.memories.at(-1)).toMatchObject({
    key: "__bob_private_tripwire__:qa-0002",
    owner: "bob",
    scope: "private",
  });
  expect(partition.cases[0]).toMatchObject({
    key: "qa-0001",
    category: "multi-hop",
    expectedKeys: ["D2:1"],
    limit: 10,
  });
});

test("LoCoMo preserves unresolved official evidence instead of inventing a dialog", () => {
  const sample = parseLocomoSample({
    ...fixture,
    qa: [{ ...fixture.qa[0], evidence: ["D99:1"] }],
  });
  expect(sample.questions[0].evidence).toEqual([]);
  expect(sample.questions[0].unresolvedEvidence).toEqual(["D99:1"]);
});

test("LoCoMo official normalization removes articles, conjunctions, punctuation, and stems", () => {
  expect(normalizeLocomoAnswer("The cats, and a DOG!")).toBe("cats dog");
  expect(normalizeLocomoAnswer("the-house")).toBe("thehouse");
  expect(evaluateLocomoAnswer({ prediction: "running", reference: "runs", category: 4 })).toBe(1);
});

test("LoCoMo stemmer matches NLTK 3.8.1 default-extension edge cases", () => {
  expect(["enjoy", "flying", "emotionally", "one", "news", "skies"].map(nltkPorterStem)).toEqual([
    "enjoy",
    "fli",
    "emot",
    "one",
    "news",
    "sky",
  ]);
});

test("LoCoMo multi-answer scoring gives each reference its best partial match", () => {
  expect(
    evaluateLocomoAnswer({
      prediction: "Ada",
      reference: "Ada, Grace",
      category: 1,
    }),
  ).toBe(0.5);
  expect(
    evaluateLocomoAnswer({
      prediction: "No information available in the conversation.",
      reference: null,
      category: 5,
    }),
  ).toBe(1);
});

test("LoCoMo partition selection is deterministic per category", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lore-locomo-"));
  const filePath = join(directory, "locomo.json");
  await writeFile(filePath, JSON.stringify([fixture]));
  try {
    const partitions = [];
    for await (const partition of readLocomoPartitions(filePath, {
      casesPerCategory: 1,
      categories: new Set([1, 2]),
    })) {
      partitions.push(partition);
    }
    expect(partitions).toHaveLength(1);
    expect(partitions[0].cases.map((item) => item.category)).toEqual(["multi-hop", "temporal"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("LoCoMo can isolate an explicit conversation for held-out evaluation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lore-locomo-sample-"));
  const filePath = join(directory, "locomo.json");
  await writeFile(filePath, JSON.stringify([fixture, { ...fixture, sample_id: "conv-held-out" }]));
  try {
    const selected = [];
    for await (const selection of readLocomoPartitions(filePath, {
      maxCases: 1,
      sampleIds: new Set(["conv-held-out"]),
    })) {
      selected.push(selection.key);
    }
    expect(selected).toEqual(["conv-held-out"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readJsonArray } from "../scripts/lib/json-array";
import {
  LONGMEMEVAL_QUESTION_TYPES,
  type LongMemEvalRecord,
  parseLongMemEvalRecord,
  readLongMemEvalPartitions,
  toLongMemEvalPartition,
} from "../scripts/lib/longmemeval";

const fixture: LongMemEvalRecord = {
  question_id: "question-1",
  question_type: "knowledge-update",
  question: "Which room should we use now?",
  answer: "The Pine room",
  question_date: "2026/08/07 (Fri) 10:00",
  answer_session_ids: ["session-2"],
  haystack_session_ids: ["session-1", "session-2"],
  haystack_dates: ["2026/08/01 (Sat) 09:00", "2026/08/06 (Thu) 16:00"],
  haystack_sessions: [
    [
      { role: "user", content: "Use the Oak room.", has_answer: false },
      { role: "assistant", content: "Noted.", has_answer: false },
    ],
    [
      { role: "user", content: "We moved the meeting to the Pine room.", has_answer: true },
      { role: "assistant", content: "I'll remember the update.", has_answer: false },
    ],
  ],
};

test("LongMemEval records become isolated session-granularity Lore partitions", () => {
  const partition = toLongMemEvalPartition(fixture);

  expect(partition).toMatchObject({
    key: "question-1",
    memories: [
      { key: "session-1", owner: "alice", scope: "private" },
      { key: "session-2", owner: "alice", scope: "private" },
      { key: "__bob_private_tripwire__", owner: "bob", scope: "private" },
    ],
    cases: [
      {
        category: "knowledge-update",
        query: "Which room should we use now?",
        expectedKeys: ["session-2"],
        forbiddenKeys: ["__bob_private_tripwire__"],
        limit: 5,
      },
    ],
  });
  expect(partition.memories[1].content).toContain("Conversation session at 2026/08/06");
  expect(partition.memories[1].content).toContain("user: We moved the meeting");
  expect(partition.memories[2].content).toContain("Answer: The Pine room");
});

test("LongMemEval validation rejects evidence outside the visible history", () => {
  expect(() =>
    parseLongMemEvalRecord({
      ...fixture,
      answer_session_ids: ["missing-session"],
    }),
  ).toThrow("references missing evidence missing-session");
});

test("LongMemEval accepts numeric aggregate answers from the official dataset", () => {
  const record = parseLongMemEvalRecord({ ...fixture, answer: 3 });
  expect(record.answer).toBe(3);
  expect(toLongMemEvalPartition(record).memories.at(-1)?.content).toContain("Answer: 3");
});

test("blank official turns are accepted but omitted from Memory content", () => {
  const record = parseLongMemEvalRecord({
    ...fixture,
    haystack_sessions: [[{ role: "user", content: "" }], fixture.haystack_sessions[1]],
  });
  expect(record.haystack_sessions[0][0].content).toBe("");
  expect(toLongMemEvalPartition(record).memories[0].content).toBe(
    "Conversation session at 2026/08/01 (Sat) 09:00",
  );
});

test("duplicate non-evidence sessions retain both timestamped occurrences", () => {
  const record = parseLongMemEvalRecord({
    ...fixture,
    haystack_session_ids: ["duplicate", "duplicate", "session-2"],
    haystack_dates: ["2026/08/01 (Sat) 09:00", "2026/08/02 (Sun) 09:00", "2026/08/06 (Thu) 16:00"],
    haystack_sessions: [
      fixture.haystack_sessions[0],
      fixture.haystack_sessions[0],
      fixture.haystack_sessions[1],
    ],
  });
  const partition = toLongMemEvalPartition(record);
  expect(partition.memories.slice(0, 3).map((memory) => memory.key)).toEqual([
    "duplicate",
    "duplicate::occurrence:2",
    "session-2",
  ]);
  expect(partition.memories[0].content).not.toBe(partition.memories[1].content);
});

test("duplicate evidence ids fail instead of choosing an arbitrary occurrence", () => {
  expect(() =>
    parseLongMemEvalRecord({
      ...fixture,
      answer_session_ids: ["session-1"],
      haystack_session_ids: ["session-1", "session-1"],
    }),
  ).toThrow("ambiguous duplicate evidence session-1");
});

test("large JSON arrays stream records correctly across tiny chunk boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lore-longmemeval-"));
  const filePath = join(directory, "fixture.json");
  const values = [
    { id: 1, text: 'quoted "brace}" and unicode 北极星', nested: { active: true } },
    { id: 2, items: [{ value: "second" }] },
  ];
  await writeFile(filePath, JSON.stringify(values));
  try {
    const parsed: unknown[] = [];
    for await (const value of readJsonArray(filePath, { highWaterMark: 7 })) parsed.push(value);
    expect(parsed).toEqual(values);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming JSON reader rejects a trailing comma", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lore-longmemeval-invalid-"));
  const filePath = join(directory, "fixture.json");
  await writeFile(filePath, '[{"id":1},]');
  try {
    const consume = async () => {
      for await (const _value of readJsonArray(filePath, { highWaterMark: 3 })) {
        // Consume the generator so structural validation reaches the array terminator.
      }
    };
    await expect(consume()).rejects.toThrow("Trailing comma");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("LongMemEval can select a deterministic number of cases per question type", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lore-longmemeval-stratified-"));
  const filePath = join(directory, "fixture.json");
  const records = LONGMEMEVAL_QUESTION_TYPES.flatMap((questionType) =>
    [1, 2].map((ordinal) => ({
      ...fixture,
      question_id: `${questionType}-${ordinal}`,
      question_type: questionType,
    })),
  );
  await writeFile(filePath, JSON.stringify(records));
  try {
    const selected = [];
    for await (const partition of readLongMemEvalPartitions(filePath, { casesPerType: 1 })) {
      selected.push(partition.cases[0].category);
    }
    expect(selected).toEqual(LONGMEMEVAL_QUESTION_TYPES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sessions beyond the canonical content bound split into anchored parts", () => {
  const longTurn = (marker: string) => `${marker} ${"memory benchmark filler ".repeat(700)}`;
  const oversized: LongMemEvalRecord = {
    ...fixture,
    haystack_sessions: [
      fixture.haystack_sessions[0],
      [
        { role: "user", content: longTurn("alpha"), has_answer: false },
        { role: "assistant", content: longTurn("beta"), has_answer: true },
        { role: "user", content: longTurn("gamma"), has_answer: false },
      ],
    ],
  };

  const partition = toLongMemEvalPartition(oversized);
  const parts = partition.memories.filter((memory) => memory.metadata?.sessionId === "session-2");

  expect(parts.length).toBeGreaterThan(1);
  expect(parts[0]).toMatchObject({ key: "session-2" });
  expect(parts[0]?.anchorKey).toBeUndefined();
  for (const [index, part] of parts.entries()) {
    expect(Array.from(part.content).length).toBeLessThanOrEqual(32_000);
    expect(part.content.startsWith("Conversation session at 2026/08/06 (Thu) 16:00")).toBe(true);
    if (index > 0) {
      expect(part.key).toBe(`session-2::part:${index + 1}`);
      expect(part.anchorKey).toBe("session-2");
    }
    expect(part.metadata).toMatchObject({
      sessionPart: index + 1,
      sessionPartCount: parts.length,
    });
  }
  // Anchoring is unchanged: the case still expects the bare session key.
  expect(partition.cases[0]?.expectedKeys).toEqual(["session-2"]);
  // Every turn's text survives across the parts.
  const joined = parts.map((part) => part.content).join("\n\n");
  for (const marker of ["alpha", "beta", "gamma"]) {
    expect(joined).toContain(marker);
  }
});

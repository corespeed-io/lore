import { expect, test } from "vitest";
import {
  chunkMemoryAgentBenchAccurateContext,
  memoryAgentBenchLiteralAnswerChunkIndex,
  memoryAgentBenchLiteralAnswerFactIndexes,
  memoryAgentBenchSubstringExactMatch,
  parseConflictResolutionFacts,
  parseMemoryAgentBenchRow,
} from "../../tools/evaluation/retrieval/memoryagentbench";

test("MemoryAgentBench row parser preserves aligned questions and accepted answers", () => {
  const row = parseMemoryAgentBenchRow({
    context: "Here is a list of facts:\n0. The capital changed to Rome.",
    questions: ["What is the capital?"],
    answers: [["Rome", "Roma"]],
    metadata: { source: "factconsolidation_sh_fixture", qa_pair_ids: ["fixture-0"] },
  });
  expect(row.metadata.source).toBe("factconsolidation_sh_fixture");
  expect(row.answers[0]).toEqual(["Rome", "Roma"]);
});

test("conflict parser retains official fact sequence numbers", () => {
  expect(
    parseConflictResolutionFacts(
      "Here is a list of facts:\n0. The capital is Paris.\n1. The capital is Rome.\n",
    ),
  ).toEqual(["0. The capital is Paris.", "1. The capital is Rome."]);
});

test("MemoryAgentBench substring exact match mirrors official normalization", () => {
  expect(memoryAgentBenchSubstringExactMatch("Answer: the Belgium.", ["Belgium"])).toBe(true);
  expect(memoryAgentBenchSubstringExactMatch("Answer: Belgian", ["Belgium"])).toBe(false);
});

test("the official metric strips only ASCII punctuation, like upstream string.punctuation", () => {
  // Upstream keeps curly quotes, so a curly-quoted reference is not matched by a
  // straight or unquoted prediction; ASCII quotes are stripped on both sides.
  expect(memoryAgentBenchSubstringExactMatch("rock n roll", ["rock ’n’ roll"])).toBe(false);
  expect(memoryAgentBenchSubstringExactMatch("rock n roll", ["rock 'n' roll"])).toBe(true);
  expect(memoryAgentBenchSubstringExactMatch("It is 5C", ["5°C"])).toBe(false);
  expect(memoryAgentBenchSubstringExactMatch("“Rome”", ["Rome"])).toBe(true);
  // A trailing "a" after a non-ASCII letter is part of the word, as with Python's
  // Unicode \b, so it is not dropped as an article.
  expect(memoryAgentBenchSubstringExactMatch("éa b", ["é b"])).toBe(false);
  expect(memoryAgentBenchSubstringExactMatch("the café, a end", ["café end"])).toBe(true);
  // The broader normalization still anchors curly-quoted facts for diagnostics.
  expect(
    memoryAgentBenchLiteralAnswerFactIndexes(
      ["0. The band played “rock ’n’ roll”."],
      ["rock 'n' roll"],
    ),
  ).toEqual([0]);
});

test("MemoryAgentBench maps literal answer anchors to numbered facts", () => {
  expect(
    memoryAgentBenchLiteralAnswerFactIndexes(
      ["0. Alice's spouse is Bob.", "1. Bob was born in Rome."],
      ["Rome"],
    ),
  ).toEqual([1]);
});

test("MemoryAgentBench chooses the answer chunk with strongest query overlap", () => {
  expect(
    memoryAgentBenchLiteralAnswerChunkIndex(
      [
        "France appears in an unrelated travel advertisement.",
        "Normandy is a region located in France.",
      ],
      "In what country is Normandy located?",
      ["France"],
    ),
  ).toBe(1);
  expect(memoryAgentBenchLiteralAnswerChunkIndex(["Option A"], "Which option?", ["A"])).toBeNull();
  expect(
    memoryAgentBenchLiteralAnswerChunkIndex(
      [
        "Catholicism was the state religion of France.",
        "The Normans adopted Catholicism and formed Norman culture in northern France.",
      ],
      "What religion were the Normans?",
      ["Catholicism"],
    ),
  ).toBe(1);
  expect(
    memoryAgentBenchLiteralAnswerChunkIndex(
      [
        "The Normans met their Viking brethren near England.",
        'The name Norman meant "Norseman, Viking".',
      ],
      "What is the original meaning of the word Norman?",
      ["Viking", "Norseman, Viking"],
    ),
  ).toBe(1);
  expect(
    memoryAgentBenchLiteralAnswerChunkIndex(
      [
        "Families from France later moved to North America and had Norman ancestry.",
        "The Normans formed a culture in the north of France.",
      ],
      "What part of France were the Normans located?",
      ["north"],
    ),
  ).toBe(1);
});

test("MemoryAgentBench preserves RULER document boundaries before length chunking", () => {
  expect(
    chunkMemoryAgentBenchAccurateContext(
      "Document 1:\nCatholic schools operate locally.\n\nDocument 2:\nThe Normans fought abroad.",
    ),
  ).toEqual([
    "Document 1:\nCatholic schools operate locally.",
    "Document 2:\nThe Normans fought abroad.",
  ]);

  const chunks = chunkMemoryAgentBenchAccurateContext(
    "Document 1:\nCatholic schools operate locally.\n\n" +
      "Document 2:\nThe Normans became exponents of Catholic orthodoxy.",
  );
  expect(
    memoryAgentBenchLiteralAnswerChunkIndex(chunks, "What religion were the Normans?", [
      "Catholic",
      "Catholic orthodoxy",
    ]),
  ).toBe(1);
});

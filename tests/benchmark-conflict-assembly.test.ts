import { expect, test } from "vitest";
import {
  assembleVersionedMultiHopAnswer,
  assembleVersionedSingleHopAnswer,
} from "../scripts/lib/benchmark-conflict-assembly";
import type { BenchmarkReaderProvider } from "../scripts/lib/benchmark-reader";

function readerReturning(text: string): BenchmarkReaderProvider {
  return {
    provider: "test",
    model: "deterministic",
    revision: "test-v1",
    profile: "lore-portable-deterministic-v2",
    transport: "openai-chat-completions",
    instruction: "test",
    maximumContextCharacters: 10_000,
    decoding: {
      temperature: 0,
      topP: null,
      topK: null,
      maximumOutputTokens: 128,
    },
    supportsQuestionImages: false,
    async answer() {
      return {
        text,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      };
    },
  };
}

test("conflict assembly validates extracted evidence before applying max serial", async () => {
  const result = await assembleVersionedSingleHopAnswer({
    reader: readerReturning(
      JSON.stringify({
        candidates: [
          { evidence_id: "e1", answer_span: "Japanese" },
          { evidence_id: "e2", answer_span: "Swedish" },
          { evidence_id: "e99", answer_span: "Klingon" },
        ],
      }),
    ),
    question: "What is Japan's language?",
    evidence: [
      {
        id: "memory",
        text: "10. Japan's language is Japanese.\n42. Japan's language is Swedish.",
      },
    ],
  });

  expect(result.answer).toMatchObject({ text: "Answer: Swedish", totalTokens: 15 });
  expect(result).toMatchObject({ sourceFactCount: 2, candidatePoolFactCount: 2 });
  expect(result.candidatePool).toEqual([
    { serial: 10, factText: "Japan's language is Japanese." },
    { serial: 42, factText: "Japan's language is Swedish." },
  ]);
  expect(result.candidates.map((candidate) => candidate.serial)).toEqual([10, 42]);
  expect(result.selected).toMatchObject({ serial: 42, answerEntity: "Swedish" });
  expect(result.extractionValidation).toEqual({
    status: "valid-with-rejections",
    rawCandidateCount: 3,
    groundedSeedCount: 2,
    acceptedCandidateCount: 2,
    frameCount: 1,
    selectedFrameSeedCount: 2,
    expandedCandidateCount: 0,
    discardedFrameSeedCount: 0,
    rejections: { shape: 0, evidenceId: 1, answerSpan: 0 },
  });
});

test("conflict assembly closes an exact answer frame and discards a different relation", async () => {
  const result = await assembleVersionedSingleHopAnswer({
    reader: readerReturning(
      JSON.stringify({
        candidates: [
          { evidence_id: "e1", answer_span: "Rurouni Kenshin" },
          { evidence_id: "e3", answer_span: "Vito Corleone" },
        ],
      }),
    ),
    question: "What is Nobuhiro Watsuki famous for?",
    evidence: [
      {
        id: "memory",
        text: [
          "91. Nobuhiro Watsuki is famous for Rurouni Kenshin.",
          "259. Nobuhiro Watsuki is famous for The Fairly OddParents.",
          "390. Vito Corleone was created by Nobuhiro Watsuki.",
        ].join("\n"),
      },
    ],
  });

  expect(result.answer.text).toBe("Answer: The Fairly OddParents");
  expect(result.candidates.map(({ serial }) => serial)).toEqual([91, 259]);
  expect(result.extractionValidation).toMatchObject({
    groundedSeedCount: 2,
    acceptedCandidateCount: 2,
    frameCount: 2,
    selectedFrameSeedCount: 1,
    expandedCandidateCount: 1,
    discardedFrameSeedCount: 1,
  });
});

test("conflict assembly derives the serial from a prompt-local authorized evidence id", async () => {
  const result = await assembleVersionedSingleHopAnswer({
    reader: readerReturning(
      JSON.stringify({
        candidates: [
          {
            evidence_id: "e2",
            answer_span: "Muay Thai",
          },
        ],
      }),
    ),
    question: "Which sport is quarterback associated with?",
    evidence: [
      {
        id: "memory",
        text: "31. quarterback is associated with the sport of American football.\n50. quarterback is associated with the sport of Muay Thai.",
      },
    ],
  });

  expect(result.answer.text).toBe("Answer: Muay Thai");
  expect(result.selected).toMatchObject({ serial: 50, claimedSerial: null });
});

test("conflict assembly requires the answer span to be grounded in the selected fact", async () => {
  const result = await assembleVersionedSingleHopAnswer({
    reader: readerReturning(
      JSON.stringify({
        candidates: [
          {
            evidence_id: "e1",
            answer_span: "Klingon",
          },
        ],
      }),
    ),
    question: "Which country was rugby union created in?",
    evidence: [{ id: "memory", text: "186. rugby union was created in the country of India." }],
  });

  expect(result.answer.text).toBe("Answer: UNKNOWN");
  expect(result.extractionValidation).toMatchObject({
    status: "invalid-candidates",
    rejections: { answerSpan: 1 },
  });
});

test("conflict assembly rejects a whole-fact answer span that has no comparison frame", async () => {
  const fact = "rugby union was created in the country of India";
  const result = await assembleVersionedSingleHopAnswer({
    reader: readerReturning(
      JSON.stringify({ candidates: [{ evidence_id: "e1", answer_span: fact }] }),
    ),
    question: "Which country was rugby union created in?",
    evidence: [{ id: "memory", text: `186. ${fact}.` }],
  });

  expect(result.answer.text).toBe("Answer: UNKNOWN");
  expect(result.extractionValidation).toMatchObject({
    status: "invalid-candidates",
    rejections: { answerSpan: 1 },
  });
});

test("conflict assembly compacts authorized evidence to a fact-level top ten pool", async () => {
  const filler = Array.from(
    { length: 20 },
    (_, index) => `${index + 1}. filler entity ${index + 1} has unrelated value ${index + 1}.`,
  );
  filler.push("100. The official language of Japan is Japanese.");
  filler.push("200. The official language of Japan is Swedish.");
  let readerEvidence: string[] = [];
  const reader = readerReturning("");
  reader.answer = async (input) => {
    readerEvidence = input.evidence.map((item) => item.text);
    return {
      text: JSON.stringify({
        candidates: input.evidence
          .filter((item) => item.text.includes("official language of Japan"))
          .map((item) => ({
            evidence_id: item.id,
            answer_span: item.text.includes("Swedish") ? "Swedish" : "Japanese",
          })),
      }),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };
  };

  const result = await assembleVersionedSingleHopAnswer({
    reader,
    question: "What is the official language of Japan?",
    evidence: [{ id: "memory", text: filler.join("\n") }],
  });

  expect(result).toMatchObject({ sourceFactCount: 22, candidatePoolFactCount: 10 });
  expect(readerEvidence).toContain("100. The official language of Japan is Japanese.");
  expect(readerEvidence).toContain("200. The official language of Japan is Swedish.");
  expect(result.answer.text).toBe("Answer: Swedish");
});

test("conflict assembly abstains on malformed or unsupported candidates", async () => {
  const result = await assembleVersionedSingleHopAnswer({
    reader: readerReturning(
      'prefix {"candidates":[{"evidence_id":"e99","answer_span":"Mars"}]} suffix',
    ),
    question: "Where?",
    evidence: [{ id: "memory", text: "7. The office is in Paris." }],
  });

  expect(result.answer.text).toBe("Answer: UNKNOWN");
  expect(result.candidates).toEqual([]);
});

test("CAR decomposes a multi-hop question and retrieves each resolved hop under a callback", async () => {
  const responses = [
    JSON.stringify({
      hops: [
        { id: 1, query: "Which sport is goaltender associated with?" },
        { id: 2, query: "Which country is {hop_1_answer} associated with?" },
      ],
    }),
    JSON.stringify({
      candidates: [
        {
          evidence_id: "e1",
          answer_span: "pesäpallo",
        },
      ],
    }),
    JSON.stringify({
      candidates: [
        {
          evidence_id: "e1",
          answer_span: "Finland",
        },
      ],
    }),
  ];
  const reader = readerReturning("");
  reader.answer = async () => ({
    text: responses.shift() ?? "{}",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  const queries: string[] = [];

  const result = await assembleVersionedMultiHopAnswer({
    reader,
    question: "Which country is the sport associated with goaltender associated with?",
    async retrieve(query) {
      queries.push(query);
      return query.includes("goaltender")
        ? [
            {
              id: "hop-1",
              text: "310. goaltender is associated with the sport of pesäpallo.",
            },
          ]
        : [
            {
              id: "hop-2",
              text: "400. pesäpallo is associated with the country of Finland.",
            },
          ];
    },
  });

  expect(queries).toEqual([
    "Which sport is goaltender associated with?",
    "Which country is pesäpallo associated with?",
  ]);
  expect(result.answer).toMatchObject({
    text: "Answer: Finland",
    inputTokens: 30,
    outputTokens: 15,
    totalTokens: 45,
  });
  expect(result.trace.map((hop) => hop.selected?.serial)).toEqual([310, 400]);
  expect(result.decompositionAttempts).toEqual([
    { raw: expect.any(String), status: "valid", hopCount: 2 },
  ]);
});

test("CAR retries a structurally invalid one-hop shortcut once", async () => {
  const responses = [
    JSON.stringify({ hops: [{ id: 1, query: "What sport does Alex play?" }] }),
    JSON.stringify({
      hops: [
        { id: 1, query: "What position does Alex play?" },
        { id: 2, query: "What sport is {hop_1_answer} associated with?" },
      ],
    }),
    JSON.stringify({ candidates: [{ evidence_id: "e1", answer_span: "placekicker" }] }),
    JSON.stringify({ candidates: [{ evidence_id: "e1", answer_span: "rugby" }] }),
  ];
  const reader = readerReturning("");
  reader.answer = async () => ({
    text: responses.shift() ?? "{}",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });

  const result = await assembleVersionedMultiHopAnswer({
    reader,
    question: "What sport is Alex known for through Alex's position on the team?",
    async retrieve(query) {
      return query.includes("position")
        ? [{ id: "hop-1", text: "419. Alex plays the position of placekicker." }]
        : [{ id: "hop-2", text: "321. placekicker is associated with the sport of rugby." }];
    },
  });

  expect(result.answer.text).toBe("Answer: rugby");
  expect(result.decompositionAttempts.map(({ status }) => status)).toEqual([
    "not-multi-hop",
    "valid",
  ]);
  expect(result.answer).toMatchObject({ inputTokens: 40, outputTokens: 20, totalTokens: 60 });
});

test("CAR rejects overlong decompositions instead of truncating them into a valid chain", async () => {
  const overlong = JSON.stringify({
    hops: Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      query:
        index === 0 ? "What is related to Alice?" : `What is related to {hop_${index}_answer}?`,
    })),
  });
  const reader = readerReturning(overlong);

  const result = await assembleVersionedMultiHopAnswer({
    reader,
    question: "Follow the complete seven-hop chain from Alice.",
    async retrieve() {
      throw new Error("An invalid decomposition must not retrieve evidence");
    },
  });

  expect(result.answer.text).toBe("Answer: UNKNOWN");
  expect(result.decomposition).toEqual([]);
  expect(result.decompositionAttempts.map(({ status }) => status)).toEqual([
    "invalid-hop-chain",
    "invalid-hop-chain",
  ]);
});

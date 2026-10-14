import { describe, expect, it } from "vitest";
import {
  alternatePacket,
  answerDeclines,
  answerTextPresent,
  attachSourcesToMemory,
  combineSourcesWithRaw,
  type EvidencePacketItem,
  evidenceTurnCoverage,
  keywordOrQuery,
  mcnemarExactP,
  pairedBootstrap95,
  rawSourceKeyForMemory,
} from "../../tools/evaluation/retrieval/memory-source-expansion";
import { renderBenchmarkReaderInput } from "../../tools/evaluation/shared/benchmark-reader";
import { codexTurnUsage } from "../../tools/evaluation/shared/codex-exec";

const memory = (key: string, text: string): EvidencePacketItem => ({
  id: `memory:${key}`,
  channel: "memory",
  sessionId: key.split("::")[0] ?? key,
  text,
});
const raw = (key: string, text: string): EvidencePacketItem => ({
  id: `raw:${key}`,
  channel: "raw",
  sessionId: key.split("::")[0] ?? key,
  text,
});

describe("keyword OR rewrite", () => {
  it("keeps distinct non-stopword terms joined as a websearch OR", () => {
    expect(keywordOrQuery("What degree did I graduate with, and what degree?")).toBe(
      "degree or graduate",
    );
    expect(keywordOrQuery("How many Rolleiflex cameras do I own in 2023?")).toBe(
      "many or Rolleiflex or cameras or 2023",
    );
  });

  it("drops trailing apostrophes and keeps the question when nothing survives", () => {
    expect(keywordOrQuery("Where's my partners' cat?")).toBe("Where's or partners or cat");
    expect(keywordOrQuery("What is it?")).toBe("What is it?");
  });
});

describe("source mapping", () => {
  it("maps fact parts to their session and keeps duplicate-session occurrences", () => {
    expect(rawSourceKeyForMemory("sharegpt_vXNQZ2I_0::part:3")).toBe("sharegpt_vXNQZ2I_0");
    expect(rawSourceKeyForMemory("d5d1f9c4::occurrence:2")).toBe("d5d1f9c4::occurrence:2");
    expect(rawSourceKeyForMemory("answer_edb03329")).toBe("answer_edb03329");
  });
});

describe("attaching sources to Memory hits", () => {
  const question = "Question time: 2023/05/30\nWhat did I buy?";

  it("places each source after its hit in Memory rank order and attaches a shared source once", () => {
    const packet = attachSourcesToMemory({
      question,
      memory: [memory("a::part:2", "fact a2"), memory("b", "fact b"), memory("a", "fact a")],
      sources: new Map([
        ["a", raw("a", "raw a")],
        ["b", raw("b", "raw b")],
      ]),
      maximumCharacters: 24_000,
    });
    expect(packet.map((item) => item.id)).toEqual([
      "memory:a::part:2",
      "raw:a",
      "memory:b",
      "raw:b",
      "memory:a",
    ]);
  });

  it("never cuts Memory evidence and trims only the last source that crosses the cap", () => {
    const facts = [memory("a", "A".repeat(300)), memory("b", "B".repeat(300))];
    const memoryOnly = renderBenchmarkReaderInput(question, facts, 24_000).length;
    const cap = memoryOnly + 600;
    const packet = attachSourcesToMemory({
      question,
      memory: facts,
      sources: new Map([
        ["a", raw("a", "x".repeat(2_000))],
        ["b", raw("b", "y".repeat(2_000))],
      ]),
      maximumCharacters: cap,
    });
    const rendered = renderBenchmarkReaderInput(question, packet, cap);
    expect(rendered.length).toBeLessThanOrEqual(cap);
    expect(rendered).toBe(renderBenchmarkReaderInput(question, packet, Number.MAX_SAFE_INTEGER));
    expect(rendered).toContain("A".repeat(300));
    expect(rendered).toContain("B".repeat(300));
    expect(packet.map((item) => item.id)).toEqual(["memory:a", "raw:a", "memory:b"]);
    expect(packet[1]?.text.length).toBeGreaterThan(400);
    expect(packet[1]?.text.length).toBeLessThan(600);
  });

  it("drops a trimmed fragment too short to be evidence", () => {
    const facts = [memory("a", "fact a")];
    const memoryOnly = renderBenchmarkReaderInput(question, facts, 24_000).length;
    const packet = attachSourcesToMemory({
      question,
      memory: facts,
      sources: new Map([["a", raw("a", "x".repeat(2_000))]]),
      maximumCharacters: memoryOnly + 150,
    });
    expect(packet.map((item) => item.id)).toEqual(["memory:a"]);
  });

  it("refuses Memory evidence that does not fit by itself", () => {
    expect(() =>
      attachSourcesToMemory({
        question,
        memory: [memory("a", "A".repeat(500))],
        sources: new Map(),
        maximumCharacters: 200,
      }),
    ).toThrow("Memory evidence alone exceeds the reader cap");
  });
});

describe("combining Memory-hit sources with independent raw excerpts", () => {
  const question = "Question time: 2023/05/30\nWhat did I buy?";
  const facts = [memory("a", "A".repeat(300)), memory("b", "B".repeat(300))];
  const memoryOnly = renderBenchmarkReaderInput(question, facts, 24_000).length;

  it("gives sources their share, then appends excerpts from other sources", () => {
    const cap = memoryOnly + 2_000;
    const packet = combineSourcesWithRaw({
      question,
      memory: facts,
      sources: new Map([
        ["a", raw("a", "s".repeat(5_000))],
        ["b", raw("b", "t".repeat(5_000))],
      ]),
      raw: [
        raw("a", "duplicate of an attached source"),
        raw("x", "x".repeat(400)),
        raw("y", "y".repeat(5_000)),
      ],
      maximumCharacters: cap,
      sourceShare: 0.5,
    });
    expect(packet.map((item) => item.id)).toEqual([
      "memory:a",
      "raw:a",
      "memory:b",
      "raw:x",
      "raw:y",
    ]);
    const rendered = renderBenchmarkReaderInput(question, packet, cap);
    expect(rendered.length).toBeLessThanOrEqual(cap);
    expect(rendered).toContain("A".repeat(300));
    expect(rendered).toContain("B".repeat(300));
    expect(packet[1]?.text.length).toBeLessThan(1_000);
    expect(packet[3]?.text).toBe("x".repeat(400));
  });

  it("lets excerpts use whatever the sources leave unused", () => {
    const cap = memoryOnly + 2_000;
    const packet = combineSourcesWithRaw({
      question,
      memory: facts,
      sources: new Map([["a", raw("a", "short source")]]),
      raw: [raw("x", "x".repeat(1_500))],
      maximumCharacters: cap,
      sourceShare: 0.5,
    });
    expect(packet.map((item) => item.id)).toEqual(["memory:a", "raw:a", "memory:b", "raw:x"]);
    expect(packet[3]?.text).toBe("x".repeat(1_500));
  });

  it("refuses a share outside zero to one", () => {
    expect(() =>
      combineSourcesWithRaw({
        question,
        memory: facts,
        sources: new Map(),
        raw: [],
        maximumCharacters: 24_000,
        sourceShare: 1.5,
      }),
    ).toThrow("sourceShare must be between 0 and 1");
  });
});

describe("the parallel dual order", () => {
  it("alternates Memory and raw ranks", () => {
    expect(
      alternatePacket(
        [memory("a", "1"), memory("b", "2")],
        [raw("x", "3"), raw("y", "4"), raw("z", "5")],
      ).map((item) => item.id),
    ).toEqual(["memory:a", "raw:x", "memory:b", "raw:y", "raw:z"]);
  });
});

describe("offline diagnostics", () => {
  it("counts an evidence turn when half of its long lines reach the reader", () => {
    const turn =
      "I bought a 1950s Rolleiflex at the estate sale.\nIt cost me forty dollars in cash.";
    expect(
      evidenceTurnCoverage("... i bought a 1950s  rolleiflex at the estate sale. ...", [turn]),
    ).toBe(1);
    expect(evidenceTurnCoverage("nothing relevant here", [turn])).toBe(0);
    expect(evidenceTurnCoverage("anything", [])).toBeNull();
  });

  it("checks only short reference answers verbatim", () => {
    expect(answerTextPresent("We met on February 1st, I think.", "February 1st.")).toBe(true);
    expect(answerTextPresent("We met in March.", "February 1st")).toBe(false);
    expect(
      answerTextPresent(
        "anything",
        "The user would prefer resources specific to Adobe Premiere Pro",
      ),
    ).toBeNull();
  });
});

describe("the Memory-first gate", () => {
  it("escalates a full or partial decline", () => {
    expect(answerDeclines("The evidence is insufficient to answer this.")).toBe(true);
    expect(answerDeclines("Your records don't mention a second trip.")).toBe(true);
    expect(answerDeclines("I cannot determine the date from the memory.")).toBe(true);
    expect(
      answerDeclines("You liked a bluegrass band; its name was not provided in the evidence."),
    ).toBe(true);
  });

  it("keeps a confident answer on Memory, even a wrong one", () => {
    expect(answerDeclines("You waited **over a year** for the decision.")).toBe(false);
    expect(answerDeclines("You have played 2 sports competitively.")).toBe(false);
  });
});

describe("paired statistics", () => {
  it("matches the baseline's exact McNemar p-value", () => {
    expect(mcnemarExactP(5, 1)).toBeCloseTo(0.21875, 12);
    expect(mcnemarExactP(0, 0)).toBe(1);
    expect(mcnemarExactP(3, 3)).toBe(1);
  });

  it("is deterministic and brackets the observed mean", () => {
    const deltas = [...Array(490).fill(0), ...Array(8).fill(1), ...Array(2).fill(-1)];
    const [low, high] = pairedBootstrap95(deltas);
    expect(pairedBootstrap95(deltas)).toEqual([low, high]);
    expect(low).toBeLessThanOrEqual(6 / 500);
    expect(high).toBeGreaterThanOrEqual(6 / 500);
  });
});

describe("Codex turn usage", () => {
  it("reads the last completed turn and ignores non-JSON lines", () => {
    expect(
      codexTurnUsage([
        "warning: something",
        '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}',
        '{"type":"item.completed"}',
        '{"type":"turn.completed","usage":{"input_tokens":10714,"cached_input_tokens":9000,"output_tokens":5}}',
        "",
      ]),
    ).toEqual({ inputTokens: 10714, outputTokens: 5 });
    expect(codexTurnUsage(['{"type":"turn.failed"}'])).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });
});

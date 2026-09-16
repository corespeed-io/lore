import type {
  BenchmarkReaderEvidence,
  BenchmarkReaderProvider,
  BenchmarkReaderResult,
} from "./benchmark-reader";

export const BENCHMARK_CONFLICT_ASSEMBLY_PROTOCOL = {
  revision: "mab-conflict-candidate-assembly-v7",
  paper: {
    title: "Reliable Post-Retrieval Assembly for Agent Memory",
    arxiv: "https://arxiv.org/abs/2606.01435",
    version: "v2 (2026-08-02)",
  },
  sourceRevision: "cvikasreddy/memory-conflict-resolution@7d319f460b0ee0945d7de05d06c34681dceca46a",
  sourceUrl:
    "https://github.com/cvikasreddy/memory-conflict-resolution/tree/7d319f460b0ee0945d7de05d06c34681dceca46a",
  policy: "maximum-explicit-fact-serial",
  candidatePool: "authorized-memory-retrieval-then-bm25-fact-top-10",
  extractionContract:
    "prompt-local-evidence-id-plus-exact-answer-span-with-server-derived-exact-frame-closure",
  candidatePoolReference: {
    title: "The Probabilistic Relevance Framework: BM25 and Beyond",
    doi: "https://doi.org/10.1561/1500000019",
  },
  scope: "explicitly-versioned-single-hop-current-value-questions",
} as const;

export const BENCHMARK_CONFLICT_CAR_PROTOCOL = {
  revision: "mab-conflict-car-v7",
  paper: BENCHMARK_CONFLICT_ASSEMBLY_PROTOCOL.paper,
  sourceRevision: BENCHMARK_CONFLICT_ASSEMBLY_PROTOCOL.sourceRevision,
  sourceUrl: BENCHMARK_CONFLICT_ASSEMBLY_PROTOCOL.sourceUrl,
  policy: "decompose-retrieve-extract-max-serial-per-hop",
  retrievalBoundary: "fresh-rls-authorized-lore-search-per-hop",
  structuredOutput:
    "native-json-schema-on-ollama-prompt-only-otherwise-plus-evidence-id-answer-span-source-validation",
  decompositionValidation: "known-multi-hop-linear-chain-with-at-least-two-atomic-hops",
  retryPolicy: "one-structural-decomposition-repair-no-semantic-empty-retry",
  decompositionPrompt: "official-source-verbatim-first-attempt",
  entityHopReference: {
    title: "Multi-step Entity-centric Information Retrieval for Multi-Hop Question Answering",
    doi: "https://doi.org/10.18653/v1/D19-5816",
  },
  maximumHops: 6,
  scope: "explicitly-versioned-multi-hop-current-value-questions",
} as const;

const candidatePoolLimit = 10;

const candidateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidence_id", "answer_span"],
        properties: {
          evidence_id: { type: "string" },
          answer_span: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
  },
} as const;

const decompositionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hops"],
  properties: {
    hops: {
      type: "array",
      maxItems: BENCHMARK_CONFLICT_CAR_PROTOCOL.maximumHops,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "query"],
        properties: {
          id: { type: "integer" },
          query: { type: "string" },
        },
      },
    },
  },
} as const;

const extractionInstruction = `Extract candidates from explicitly versioned facts.
Do not answer the question, compare versions, select a winner, or use world knowledge.
Include every fact only when its subject and relation directly answer the question, including all conflicting values.
For each match, copy its short evidence id and the exact answer span from that same fact. Do not copy the fact or serial.
Return JSON only: {"candidates":[{"evidence_id":"e1","answer_span":"exact value copied from that fact"}]}`;

interface Candidate {
  serial: number;
  claimedSerial: number | null;
  factText: string;
  answerEntity: string;
}

export interface BenchmarkConflictCandidateValidation {
  status: "invalid-candidates" | "malformed" | "valid" | "valid-empty" | "valid-with-rejections";
  rawCandidateCount: number;
  groundedSeedCount: number;
  acceptedCandidateCount: number;
  frameCount: number;
  selectedFrameSeedCount: number;
  expandedCandidateCount: number;
  discardedFrameSeedCount: number;
  rejections: {
    shape: number;
    evidenceId: number;
    answerSpan: number;
  };
}

export interface BenchmarkConflictHop {
  id: number;
  query: string;
}

export interface BenchmarkConflictDecompositionAttempt {
  raw: string;
  status: "invalid-hop-chain" | "malformed" | "not-multi-hop" | "valid";
  hopCount: number;
}

export interface BenchmarkConflictCarTrace {
  hop: BenchmarkConflictHop;
  resolvedQuery: string;
  evidenceIds: string[];
  sourceFactCount: number;
  candidatePoolFactCount: number;
  candidatePool: Array<{ serial: number; factText: string }>;
  extraction: string;
  extractionValidation: BenchmarkConflictCandidateValidation;
  candidateCount: number;
  selected: Candidate | null;
}

export interface BenchmarkConflictCarResult {
  answer: BenchmarkReaderResult;
  rawDecomposition: string;
  decompositionAttempts: BenchmarkConflictDecompositionAttempt[];
  decomposition: BenchmarkConflictHop[];
  trace: BenchmarkConflictCarTrace[];
}

export interface BenchmarkConflictAssemblyResult {
  answer: BenchmarkReaderResult;
  extraction: string;
  sourceFactCount: number;
  candidatePoolFactCount: number;
  candidatePool: Array<{ serial: number; factText: string }>;
  candidates: Candidate[];
  extractionValidation: BenchmarkConflictCandidateValidation;
  selected: Candidate | null;
}

function normalizedFactText(value: string): string {
  return value
    .trim()
    .replace(/[.\s]+$/, "")
    .toLocaleLowerCase("en-US");
}

interface ExactAnswerFrame {
  prefix: string;
  suffix: string;
  signature: string;
}

function factSurface(value: string): string {
  return value.trim().replace(/[.\s]+$/, "");
}

function exactAnswerFrame(factText: string, answerSpan: string): ExactAnswerFrame | null {
  const surface = factSurface(factText);
  const normalizedSurface = surface.toLocaleLowerCase("en-US");
  const normalizedAnswer = factSurface(answerSpan).toLocaleLowerCase("en-US");
  if (!normalizedAnswer || normalizedAnswer.length > 256) return null;
  const answerIndex = normalizedSurface.lastIndexOf(normalizedAnswer);
  if (answerIndex < 0) return null;
  const prefix = surface.slice(0, answerIndex);
  const suffix = surface.slice(answerIndex + normalizedAnswer.length);
  if (!prefix.trim() && !suffix.trim()) return null;
  return {
    prefix,
    suffix,
    signature: `${prefix.toLocaleLowerCase("en-US")}\u0000${suffix.toLocaleLowerCase("en-US")}`,
  };
}

function answerForExactFrame(frame: ExactAnswerFrame, factText: string): string | null {
  const surface = factSurface(factText);
  const normalizedSurface = surface.toLocaleLowerCase("en-US");
  const normalizedPrefix = frame.prefix.toLocaleLowerCase("en-US");
  const normalizedSuffix = frame.suffix.toLocaleLowerCase("en-US");
  if (
    !normalizedSurface.startsWith(normalizedPrefix) ||
    !normalizedSurface.endsWith(normalizedSuffix) ||
    surface.length <= frame.prefix.length + frame.suffix.length
  ) {
    return null;
  }
  const answerEnd = surface.length - frame.suffix.length;
  const answer = surface.slice(frame.prefix.length, answerEnd).trim();
  return answer || null;
}

function versionedFacts(evidence: BenchmarkReaderEvidence[]): Map<number, string> {
  const facts = new Map<number, string>();
  for (const item of evidence) {
    for (const line of item.text.split(/\r?\n/)) {
      const match = /^\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const serial = Number(match[1]);
      if (!Number.isSafeInteger(serial) || serial < 0 || facts.has(serial)) continue;
      facts.set(serial, match[2]);
    }
  }
  return facts;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? [];
}

function compactFactPool(
  question: string,
  facts: Map<number, string>,
  limit = candidatePoolLimit,
): Map<number, string> {
  const documents = [...facts].map(([serial, factText]) => ({
    serial,
    factText,
    tokens: tokens(factText),
  }));
  if (documents.length <= limit)
    return new Map(documents.map(({ serial, factText }) => [serial, factText]));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength =
    documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length;
  const queryTerms = tokens(question);
  const scored = documents.map((document) => {
    const frequencies = new Map<string, number>();
    for (const term of document.tokens) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const containing = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (documents.length - containing + 0.5) / (containing + 0.5),
      );
      const denominator =
        frequency + 1.5 * (1 - 0.75 + 0.75 * (document.tokens.length / averageLength));
      score += inverseDocumentFrequency * ((frequency * (1.5 + 1)) / denominator);
    }
    return { ...document, score };
  });
  scored.sort((left, right) => right.score - left.score || right.serial - left.serial);
  return new Map(scored.slice(0, limit).map(({ serial, factText }) => [serial, factText]));
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decompositionPrompt(question: string, repairReason?: string): string {
  const repair = repairReason
    ? `\n<REPAIR>A previous response failed structural validation (${repairReason}). Return at least two hops. Every hop after hop 1 MUST literally contain the immediately preceding {hop_N_answer} placeholder. Never replace that placeholder with pronouns such as "this", "that", "it", or "the same".</REPAIR>\n`
    : "";
  return `<TASK>
Decompose this multi-hop question into a chain of atomic single-hop queries. Each hop must ask about ONE relationship only.
</TASK>

<HARD_CONSTRAINT>
A single hop query may contain AT MOST ONE relationship word ("of", "by", "from", "in", "where", "associated with", "related to"). If a hop has TWO or more such words connecting entity descriptions, it is INVALID — split it into multiple hops.
</HARD_CONSTRAINT>

<RULES>
1. Each hop asks ONE question about ONE specific entity. The entity must be named in the original question OR be the answer of a previous hop, referenced via {hop_N_answer}.
2. Chain INSIDE-OUT: start from the innermost named entity in the question, then move outward one relationship at a time.
3. The hop count equals the number of relationship words in the question — never fewer.
4. No padding hops. Every hop's answer must feed a later hop or be the final answer.
</RULES>

<EXAMPLE>
<QUESTION>"What is the country of the company where the manager of the supervisor of Alice works?"</QUESTION>

<RELATIONSHIP_COUNT>4 — "supervisor of", "manager of", "company where … works", "country of"</RELATIONSHIP_COUNT>

<CORRECT>
{"hops": [
  {"id": 1, "query": "Who is the supervisor of Alice?"},
  {"id": 2, "query": "Who is the manager of {hop_1_answer}?"},
  {"id": 3, "query": "What company does {hop_2_answer} work at?"},
  {"id": 4, "query": "What country is {hop_3_answer} based in?"}
]}
</CORRECT>

<WRONG reason="hop 1 has 2 'of' words; hop 2 has 2 relationships — both violate HARD_CONSTRAINT">
{"hops": [
  {"id": 1, "query": "Who is the manager of the supervisor of Alice?"},
  {"id": 2, "query": "What country is the company where {hop_1_answer} works based in?"}
]}
</WRONG>

<WRONG reason="single hop contains 4 'of' words; entire chain compressed into one query">
{"hops": [
  {"id": 1, "query": "What country is the company where the manager of the supervisor of Alice works based in?"}
]}
</WRONG>
</EXAMPLE>
${repair}
<QUESTION>
${question}
</QUESTION>

Return ONLY valid JSON: {"hops": [{"id": 1, "query": "..."}, ...]}`;
}

function validatedDecomposition(raw: string): {
  hops: BenchmarkConflictHop[];
  status: BenchmarkConflictDecompositionAttempt["status"];
} {
  const parsed = jsonObject(raw);
  if (!parsed || !Array.isArray(parsed.hops)) return { hops: [], status: "malformed" };
  if (parsed.hops.length > BENCHMARK_CONFLICT_CAR_PROTOCOL.maximumHops) {
    return { hops: [], status: "invalid-hop-chain" };
  }
  const hops: BenchmarkConflictHop[] = [];
  for (const value of parsed.hops) {
    if (typeof value !== "object" || value === null)
      return { hops: [], status: "invalid-hop-chain" };
    const hop = value as Record<string, unknown>;
    if (typeof hop.id !== "number" || !Number.isSafeInteger(hop.id) || hop.id !== hops.length + 1) {
      return { hops: [], status: "invalid-hop-chain" };
    }
    if (typeof hop.query !== "string" || !hop.query.trim())
      return { hops: [], status: "invalid-hop-chain" };
    const hopId = hop.id;
    const references = [...hop.query.matchAll(/\{hop_(\d+)_answer\}/g)].map((match) =>
      Number(match[1]),
    );
    if (
      references.some((reference) => reference < 1 || reference >= hopId) ||
      (hopId > 1 && !references.includes(hopId - 1))
    ) {
      return { hops: [], status: "invalid-hop-chain" };
    }
    hops.push({ id: hopId, query: hop.query.trim() });
  }
  return hops.length < 2 ? { hops, status: "not-multi-hop" } : { hops, status: "valid" };
}

function sumTokenField(
  results: BenchmarkReaderResult[],
  field: "inputTokens" | "outputTokens" | "totalTokens",
): number | null {
  const values = results.map((result) => result[field]);
  return values.every((value): value is number => value !== null)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function sumNativeTiming(results: BenchmarkReaderResult[]) {
  const timings = results.map((result) => result.nativeTimingNanoseconds);
  if (timings.some((timing) => !timing)) return undefined;
  const sum = (field: "total" | "load" | "promptEvaluation" | "evaluation") => {
    const values = timings.map((timing) => timing?.[field] ?? null);
    return values.every((value): value is number => value !== null)
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  return {
    total: sum("total"),
    load: sum("load"),
    promptEvaluation: sum("promptEvaluation"),
    evaluation: sum("evaluation"),
  };
}

function validatedCandidates(
  raw: string,
  factsByEvidenceId: Map<string, { serial: number; factText: string }>,
): {
  candidates: BenchmarkConflictAssemblyResult["candidates"];
  validation: BenchmarkConflictCandidateValidation;
} {
  const parsed = jsonObject(raw);
  const emptyRejections = { shape: 0, evidenceId: 0, answerSpan: 0 };
  if (!parsed || !Array.isArray(parsed.candidates)) {
    return {
      candidates: [],
      validation: {
        status: "malformed",
        rawCandidateCount: 0,
        groundedSeedCount: 0,
        acceptedCandidateCount: 0,
        frameCount: 0,
        selectedFrameSeedCount: 0,
        expandedCandidateCount: 0,
        discardedFrameSeedCount: 0,
        rejections: emptyRejections,
      },
    };
  }
  const rejections = { ...emptyRejections };
  const rawCandidateCount = parsed.candidates.length;
  const groundedSeeds = new Map<number, { candidate: Candidate; frame: ExactAnswerFrame }>();
  for (const value of parsed.candidates) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      rejections.shape += 1;
      continue;
    }
    const candidate = value as Record<string, unknown>;
    const evidenceId = candidate.evidence_id;
    const answerSpan = candidate.answer_span;
    if (typeof evidenceId !== "string") {
      rejections.evidenceId += 1;
      continue;
    }
    const sourceFact = factsByEvidenceId.get(evidenceId);
    if (!sourceFact || groundedSeeds.has(sourceFact.serial)) {
      rejections.evidenceId += 1;
      continue;
    }
    if (
      typeof answerSpan !== "string" ||
      !answerSpan.trim() ||
      !normalizedFactText(sourceFact.factText).includes(normalizedFactText(answerSpan))
    ) {
      rejections.answerSpan += 1;
      continue;
    }
    const frame = exactAnswerFrame(sourceFact.factText, answerSpan);
    if (!frame) {
      rejections.answerSpan += 1;
      continue;
    }
    groundedSeeds.set(sourceFact.serial, {
      candidate: {
        serial: sourceFact.serial,
        claimedSerial: null,
        factText: sourceFact.factText,
        answerEntity: answerSpan.trim(),
      },
      frame,
    });
  }
  const poolFacts = [...factsByEvidenceId.values()];
  const frameGroups = new Map<
    string,
    {
      frame: ExactAnswerFrame;
      seedSerials: Set<number>;
      candidates: Candidate[];
      firstPoolRank: number;
    }
  >();
  for (const { candidate, frame } of groundedSeeds.values()) {
    const existing = frameGroups.get(frame.signature);
    if (existing) {
      existing.seedSerials.add(candidate.serial);
      continue;
    }
    const candidates: Candidate[] = [];
    let firstPoolRank = Number.POSITIVE_INFINITY;
    poolFacts.forEach((fact, index) => {
      const answerEntity = answerForExactFrame(frame, fact.factText);
      if (!answerEntity) return;
      firstPoolRank = Math.min(firstPoolRank, index);
      candidates.push({
        serial: fact.serial,
        claimedSerial: null,
        factText: fact.factText,
        answerEntity,
      });
    });
    frameGroups.set(frame.signature, {
      frame,
      seedSerials: new Set([candidate.serial]),
      candidates,
      firstPoolRank,
    });
  }
  const selectedFrame = [...frameGroups.values()].sort(
    (left, right) =>
      right.candidates.length - left.candidates.length ||
      left.firstPoolRank - right.firstPoolRank ||
      left.frame.signature.localeCompare(right.frame.signature),
  )[0];
  const accepted = (selectedFrame?.candidates ?? []).sort(
    (left, right) => left.serial - right.serial,
  );
  const rejected = rejections.shape + rejections.evidenceId + rejections.answerSpan;
  const selectedFrameSeedCount = selectedFrame?.seedSerials.size ?? 0;
  return {
    candidates: accepted,
    validation: {
      status:
        rawCandidateCount === 0
          ? "valid-empty"
          : accepted.length === 0
            ? "invalid-candidates"
            : rejected > 0
              ? "valid-with-rejections"
              : "valid",
      rawCandidateCount,
      groundedSeedCount: groundedSeeds.size,
      acceptedCandidateCount: accepted.length,
      frameCount: frameGroups.size,
      selectedFrameSeedCount,
      expandedCandidateCount: Math.max(0, accepted.length - selectedFrameSeedCount),
      discardedFrameSeedCount: groundedSeeds.size - selectedFrameSeedCount,
      rejections,
    },
  };
}

export async function assembleVersionedSingleHopAnswer(input: {
  reader: BenchmarkReaderProvider;
  question: string;
  evidence: BenchmarkReaderEvidence[];
}): Promise<BenchmarkConflictAssemblyResult> {
  const sourceFacts = versionedFacts(input.evidence);
  const facts = compactFactPool(input.question, sourceFacts);
  const factsByEvidenceId = new Map(
    [...facts].map(([serial, factText], index) => [`e${index + 1}`, { serial, factText }]),
  );
  const evidence = [...factsByEvidenceId].map(([evidenceId, fact]) => ({
    id: evidenceId,
    text: `${fact.serial}. ${fact.factText}`,
  }));
  const extraction = await input.reader.answer({
    question: input.question,
    evidence,
    systemInstruction: extractionInstruction,
    responseSchema: candidateResponseSchema,
  });
  const { candidates, validation } = validatedCandidates(extraction.text, factsByEvidenceId);
  const selected = candidates.at(-1) ?? null;
  return {
    answer: {
      ...extraction,
      text: selected ? `Answer: ${selected.answerEntity}` : "Answer: UNKNOWN",
    },
    extraction: extraction.text,
    sourceFactCount: sourceFacts.size,
    candidatePoolFactCount: facts.size,
    candidatePool: [...facts].map(([serial, factText]) => ({ serial, factText })),
    candidates,
    extractionValidation: validation,
    selected,
  };
}

export async function assembleVersionedMultiHopAnswer(input: {
  reader: BenchmarkReaderProvider;
  question: string;
  retrieve(query: string): Promise<BenchmarkReaderEvidence[]>;
}): Promise<BenchmarkConflictCarResult> {
  const readerResults: BenchmarkReaderResult[] = [];
  const decompositionAttempts: BenchmarkConflictDecompositionAttempt[] = [];
  let decomposition: BenchmarkConflictHop[] = [];
  let decompositionResult: BenchmarkReaderResult | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const previous = decompositionAttempts.at(-1);
    decompositionResult = await input.reader.answer({
      question: decompositionPrompt(input.question, previous?.status),
      evidence: [],
      systemInstruction:
        "You are a question decomposition assistant. NEVER combine multiple relationship words into a single hop query.",
      responseSchema: decompositionResponseSchema,
    });
    readerResults.push(decompositionResult);
    const validation = validatedDecomposition(decompositionResult.text);
    decompositionAttempts.push({
      raw: decompositionResult.text,
      status: validation.status,
      hopCount: validation.hops.length,
    });
    if (validation.status === "valid") {
      decomposition = validation.hops;
      break;
    }
  }
  const trace: BenchmarkConflictCarTrace[] = [];
  const answers = new Map<number, string>();
  for (const hop of decomposition) {
    let unresolved = false;
    const resolvedQuery = hop.query.replace(/\{hop_(\d+)_answer\}/g, (_match, rawId: string) => {
      const answer = answers.get(Number(rawId));
      if (!answer) {
        unresolved = true;
        return "";
      }
      return answer;
    });
    if (unresolved) break;
    const evidence = await input.retrieve(resolvedQuery);
    const assembled = await assembleVersionedSingleHopAnswer({
      reader: input.reader,
      question: resolvedQuery,
      evidence,
    });
    readerResults.push(assembled.answer);
    trace.push({
      hop,
      resolvedQuery,
      evidenceIds: evidence.map((item) => item.id),
      sourceFactCount: assembled.sourceFactCount,
      candidatePoolFactCount: assembled.candidatePoolFactCount,
      candidatePool: assembled.candidatePool,
      extraction: assembled.extraction,
      extractionValidation: assembled.extractionValidation,
      candidateCount: assembled.candidates.length,
      selected: assembled.selected,
    });
    if (!assembled.selected) break;
    answers.set(hop.id, assembled.selected.answerEntity);
  }
  const selected =
    decomposition.length > 0 && trace.length === decomposition.length
      ? (trace.at(-1)?.selected ?? null)
      : null;
  return {
    answer: {
      text: selected ? `Answer: ${selected.answerEntity}` : "Answer: UNKNOWN",
      inputTokens: sumTokenField(readerResults, "inputTokens"),
      outputTokens: sumTokenField(readerResults, "outputTokens"),
      totalTokens: sumTokenField(readerResults, "totalTokens"),
      finishReason: readerResults.at(-1)?.finishReason ?? null,
      nativeTimingNanoseconds: sumNativeTiming(readerResults),
    },
    rawDecomposition: decompositionResult?.text ?? "",
    decompositionAttempts,
    decomposition,
    trace,
  };
}

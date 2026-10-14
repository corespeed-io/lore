/**
 * Pure packet, query, diagnostic, and paired-statistics rules for the LongMemEval
 * Memory-hit source-expansion experiment (run-memory-source-expansion.ts). The
 * runner owns databases and model calls; everything here is deterministic.
 */
import { renderBenchmarkReaderInput } from "../shared/benchmark-reader";

export interface EvidencePacketItem {
  id: string;
  text: string;
  sessionId: string;
  channel: "memory" | "raw";
}

/**
 * PostgreSQL 18 `english.stop`. The English channel already drops these words; the
 * simple channel does not, and an OR of stopwords would match almost every chunk.
 */
const ENGLISH_STOP_WORDS = new Set(
  (
    "i me my myself we our ours ourselves you your yours yourself yourselves he him " +
    "his himself she her hers herself it its itself they them their theirs themselves " +
    "what which who whom this that these those am is are was were be been being have " +
    "has had having do does did doing a an the and but if or because as until while " +
    "of at by for with about against between into through during before after above " +
    "below to from up down in out on off over under again further then once here there " +
    "when where why how all any both each few more most other some such no nor not only " +
    "own same so than too very s t can will just don should now"
  ).split(" "),
);

// The term rule of Memory search's relaxed English channel (lore-core
// `relaxedEnglishTerms`, which the package does not export).
const termPattern = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

/**
 * A deterministic keyword rewrite: the question's distinct terms, without
 * stopwords, joined as a `websearch_to_tsquery` OR. The original question asks
 * one chunk for every remaining word; this asks for any of them, so ranking,
 * not matching, decides. Returns the question unchanged when no term survives.
 */
export function keywordOrQuery(question: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of question.match(termPattern) ?? []) {
    const term = match.replace(/['-]+$/u, "");
    const key = term.toLocaleLowerCase("en-US");
    if (term.length < 2 || ENGLISH_STOP_WORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms.length ? terms.slice(0, 32).join(" or ") : question;
}

/** A frozen fact Memory key names its raw session; long sessions split facts into parts. */
export function rawSourceKeyForMemory(memoryKey: string): string {
  return memoryKey.replace(/::part:\d+$/u, "");
}

export function memoryKeyOf(item: EvidencePacketItem): string {
  if (!item.id.startsWith("memory:")) throw new Error(`Not a Memory packet item: ${item.id}`);
  return item.id.slice("memory:".length);
}

/** The original dual packet order: Memory and raw ranks alternate. */
export function alternatePacket(
  memory: readonly EvidencePacketItem[],
  raw: readonly EvidencePacketItem[],
): EvidencePacketItem[] {
  return Array.from({ length: Math.max(memory.length, raw.length) }, (_, index) => [
    memory[index],
    raw[index],
  ])
    .flat()
    .filter((item): item is EvidencePacketItem => item !== undefined);
}

/** A trimmed source shorter than this is a fragment, not evidence, and is dropped. */
const MINIMUM_TRIMMED_SOURCE = 200;

/** The longest prefix that still fits, or nothing when only a fragment would. */
function fittedPrefix(text: string, fits: (prefix: string) => boolean): string | undefined {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  const prefix = text.slice(0, low);
  return prefix.trim().length >= MINIMUM_TRIMMED_SOURCE ? prefix : undefined;
}

function renderedLength(question: string, packet: readonly EvidencePacketItem[]): number {
  return renderBenchmarkReaderInput(question, [...packet], Number.MAX_SAFE_INTEGER).length;
}

/**
 * Throws unless every Memory excerpt reaches the reader whole. Every arm must pass:
 * the alternating arms may lose raw text past the cap, never Memory evidence.
 */
export function requireMemoryInsideCap(
  question: string,
  memory: readonly EvidencePacketItem[],
  packet: readonly EvidencePacketItem[],
  maximumCharacters: number,
): string {
  const rendered = renderBenchmarkReaderInput(question, [...packet], maximumCharacters);
  for (const item of memory) {
    if (!rendered.includes(item.text.trim())) throw new Error("Memory evidence was cut");
  }
  return rendered;
}

/** Source arms are built to fit, so they must also render without any cut. */
function requireIntactMemory(
  question: string,
  memory: readonly EvidencePacketItem[],
  packet: readonly EvidencePacketItem[],
  maximumCharacters: number,
): void {
  const rendered = requireMemoryInsideCap(question, memory, packet, maximumCharacters);
  if (rendered.length !== renderedLength(question, packet))
    throw new Error("Source packet exceeds the reader cap");
}

/**
 * Attaches each Memory hit's raw source excerpt directly after the hit, in Memory
 * rank order, inside the reader's character cap. Memory evidence is never cut:
 * raw text only spends what the Memory-only input leaves, the last raw block is
 * trimmed to fit, and a source shared by two hits (fact parts) is attached once.
 */
export function attachSourcesToMemory(input: {
  question: string;
  memory: readonly EvidencePacketItem[];
  sources: ReadonlyMap<string, EvidencePacketItem>;
  maximumCharacters: number;
}): EvidencePacketItem[] {
  const fits = (packet: readonly EvidencePacketItem[]) =>
    renderedLength(input.question, packet) <= input.maximumCharacters;
  if (!fits(input.memory)) throw new Error("Memory evidence alone exceeds the reader cap");
  const attached = new Set<string>();
  const raw = input.memory.map((memory) => {
    const key = rawSourceKeyForMemory(memoryKeyOf(memory));
    const source = attached.has(key) ? undefined : input.sources.get(key);
    if (source?.text.trim()) attached.add(key);
    return source?.text.trim() ? source : undefined;
  });
  const kept: Array<EvidencePacketItem | undefined> = raw.map(() => undefined);
  const interleave = () =>
    input.memory.flatMap((memory, index) => {
      const source = kept[index];
      return source ? [memory, source] : [memory];
    });
  for (const [index, source] of raw.entries()) {
    if (!source) continue;
    kept[index] = { ...source, text: source.text.trim() };
    if (fits(interleave())) continue;
    // The budget ends inside this block: keep the longest prefix that fits.
    const text = fittedPrefix(source.text.trim(), (prefix) => {
      kept[index] = { ...source, text: prefix };
      return fits(interleave());
    });
    kept[index] = text === undefined ? undefined : { ...source, text };
    break;
  }
  const packet = interleave();
  requireIntactMemory(input.question, input.memory, packet, input.maximumCharacters);
  return packet;
}

/**
 * Splits what the Memory-only input leaves of the cap. `sourceShare` of it goes
 * to Memory-hit sources attached after their hits, as in attachSourcesToMemory;
 * the rest, and whatever the sources leave unused, goes to independent raw
 * excerpts from other sources, appended in their own rank order. Memory evidence
 * is never cut, and a source already attached is not repeated as an excerpt.
 */
export function combineSourcesWithRaw(input: {
  question: string;
  memory: readonly EvidencePacketItem[];
  sources: ReadonlyMap<string, EvidencePacketItem>;
  raw: readonly EvidencePacketItem[];
  maximumCharacters: number;
  sourceShare: number;
}): EvidencePacketItem[] {
  if (!(input.sourceShare >= 0 && input.sourceShare <= 1))
    throw new Error("sourceShare must be between 0 and 1");
  const memoryOnly = renderedLength(input.question, input.memory);
  if (memoryOnly > input.maximumCharacters)
    throw new Error("Memory evidence alone exceeds the reader cap");
  let packet = attachSourcesToMemory({
    question: input.question,
    memory: input.memory,
    sources: input.sources,
    maximumCharacters:
      memoryOnly + Math.floor((input.maximumCharacters - memoryOnly) * input.sourceShare),
  });
  const attached = new Set(packet.filter((item) => item.channel === "raw").map((item) => item.id));
  const fits = (candidate: readonly EvidencePacketItem[]) =>
    renderedLength(input.question, candidate) <= input.maximumCharacters;
  for (const item of input.raw) {
    if (attached.has(item.id) || !item.text.trim()) continue;
    const whole = [...packet, { ...item, text: item.text.trim() }];
    if (fits(whole)) {
      packet = whole;
      continue;
    }
    const text = fittedPrefix(item.text.trim(), (prefix) =>
      fits([...packet, { ...item, text: prefix }]),
    );
    if (text !== undefined) packet = [...packet, { ...item, text }];
    break;
  }
  requireIntactMemory(input.question, input.memory, packet, input.maximumCharacters);
  return packet;
}

const whitespace = /\s+/gu;
const normalize = (text: string) => text.toLocaleLowerCase("en-US").replace(whitespace, " ").trim();

/**
 * The share of LongMemEval `has_answer` turns whose text reaches the reader. A
 * turn counts when at least half of its characters, in lines of 20 or more
 * characters, appear verbatim in the rendered input. Extracted facts paraphrase
 * turns, so this measures raw-source delivery, not whether facts suffice.
 */
export function evidenceTurnCoverage(rendered: string, turns: readonly string[]): number | null {
  if (!turns.length) return null;
  const haystack = normalize(rendered);
  let covered = 0;
  for (const turn of turns) {
    const lines = turn
      .split("\n")
      .map(normalize)
      .filter((line) => line.length >= 20);
    const total = lines.reduce((sum, line) => sum + line.length, 0);
    if (!total) continue;
    const present = lines
      .filter((line) => haystack.includes(line))
      .reduce((sum, line) => sum + line.length, 0);
    if (present / total >= 0.5) covered++;
  }
  return covered / turns.length;
}

/** Whether a short reference answer occurs verbatim; null when it is a sentence. */
export function answerTextPresent(rendered: string, answer: string): boolean | null {
  const reference = normalize(answer).replace(/[.!]$/u, "");
  if (!reference || reference.length > 40 || reference.split(" ").length > 5) return null;
  return normalize(rendered).includes(reference);
}

/**
 * The reader is told to say when its evidence is insufficient instead of guessing
 * (benchmark-reader.ts). These are the phrasings it uses for that, including a
 * partial decline beside an answer ("the band's name was not provided in…").
 */
const DECLINE_PATTERN = new RegExp(
  [
    "insufficient",
    "not enough",
    "no (information|record|mention|evidence|details?)",
    "(does not|doesn't|do not|don't|did not|didn't) (contain|include|mention|specify|provide|say|state|have|show|indicate|record)",
    "(cannot|can't) (determine|find|answer|confirm|tell)",
    "unable to",
    "isn't (mentioned|specified|recorded)",
    "is not (mentioned|specified|recorded|available)",
    "not (mentioned|specified|available|recorded|provided) in",
  ].join("|"),
  "iu",
);

/**
 * Whether a Memory-only answer says its evidence falls short. The gated strategy
 * reads raw sources only then. Replayed over saved answers, this is a benchmark
 * rule, not a production classifier.
 */
export function answerDeclines(answer: string): boolean {
  return DECLINE_PATTERN.test(answer);
}

/** Exact two-sided McNemar p-value over discordant pairs. */
export function mcnemarExactP(wins: number, losses: number): number {
  const total = wins + losses;
  if (total === 0) return 1;
  const smaller = Math.min(wins, losses);
  let tail = 0;
  let coefficient = 1;
  for (let k = 0; k <= smaller; k++) {
    if (k > 0) coefficient = (coefficient * (total - k + 1)) / k;
    tail += coefficient / 2 ** total;
  }
  return Math.min(1, 2 * tail);
}

/** The baseline's deterministic paired bootstrap (same generator and seed). */
export function pairedBootstrap95(deltas: readonly number[], samples = 10_000): [number, number] {
  if (!deltas.length) return [0, 0];
  let state = 20261012;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const draws = Array.from({ length: samples }, () =>
    mean(deltas.map(() => deltas[Math.floor(random() * deltas.length)] ?? 0)),
  ).sort((left, right) => left - right);
  return [draws[Math.floor(samples * 0.025)] ?? 0, draws[Math.floor(samples * 0.975) - 1] ?? 0];
}

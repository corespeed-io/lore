import type { MemorySearchResult } from "../memory-types";
import { RETRIEVAL_CJK_LEXICAL_POLICY } from "./policy";

export function relaxedEnglishTerms(query: string): string[] {
  const terms = query.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    const key = term.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(term);
  }
  return unique.slice(0, 32);
}

// Script=Common/Inherited marks that belong inside Japanese words: U+30FC
// prolonged sound mark (サーバー), U+3005 ideographic iteration (人々), and the
// kana iteration marks. U+30FB middle dot stays excluded on purpose — it
// separates words, so a run must end there.
const cjkRunPattern =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々ゝゞヽヾ]+/gu;

// Postgres 'simple'/'english' text search cannot segment CJK, so an entire
// punctuation-bounded run indexes as one token and phrase queries never match.
// This channel probes chunk content with fixed-width code-point grams from the
// query's CJK runs; grams contain only CJK script letters and the word-internal
// marks above — none are LIKE metacharacters, so no escaping is needed.
export function cjkLexicalGrams(rawQuery: string): string[] {
  // NFC first: decomposed kana carries Script=Inherited voicing marks that
  // would otherwise split runs and emit grams NFC-stored content cannot match.
  const query = rawQuery.normalize("NFC");
  const grams: string[] = [];
  const seen = new Set<string>();
  const filled = (gram: string) => {
    if (!seen.has(gram)) {
      seen.add(gram);
      grams.push(gram);
    }
    return grams.length >= RETRIEVAL_CJK_LEXICAL_POLICY.maximumQueryGrams;
  };
  for (const [run] of query.matchAll(cjkRunPattern)) {
    const codePoints = [...run];
    if (codePoints.length < 2) continue;
    if (codePoints.length < RETRIEVAL_CJK_LEXICAL_POLICY.gramCodePoints) {
      if (filled(run)) return grams;
      continue;
    }
    for (
      let index = 0;
      index + RETRIEVAL_CJK_LEXICAL_POLICY.gramCodePoints <= codePoints.length;
      index += 1
    ) {
      const gram = codePoints
        .slice(index, index + RETRIEVAL_CJK_LEXICAL_POLICY.gramCodePoints)
        .join("");
      if (filled(gram)) return grams;
    }
  }
  return grams;
}

export function evidenceTerms(text: string): Set<string> {
  return new Set(
    (text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [])
      .map((term) => term.toLocaleLowerCase())
      .filter((term) => term.length > 1),
  );
}

const feedbackStopWords = new Set([
  "about",
  "after",
  "also",
  "before",
  "does",
  "from",
  "have",
  "into",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function feedbackEvidenceExcerpt(original: string, evidence: string): string {
  const queryTerms = [...evidenceTerms(original)].filter(
    (term) => term.length > 2 && !feedbackStopWords.has(term),
  );
  const passages =
    evidence.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu)?.map((passage) => passage.trim()) ?? [];
  if (!passages.length || !queryTerms.length) return evidence.slice(0, 1_000);

  // passages is non-empty here, so the fallback is inert.
  let bestPassage = passages[0] ?? "";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [index, passage] of passages.entries()) {
    const terms = evidenceTerms(passage);
    const score = queryTerms.reduce(
      (total, term) => total + (terms.has(term) ? Math.min(term.length, 12) : 0),
      0,
    );
    const normalizedLength = Math.max(1, Math.min(passage.length, 500));
    const objective = score / Math.sqrt(normalizedLength) - index / 1_000_000;
    if (objective > bestScore) {
      bestPassage = passage;
      bestScore = objective;
    }
  }
  return (bestScore > 0 ? bestPassage : evidence).slice(0, 1_000);
}

export function retrievalQueries(original: string, planned: string[], maximum: number): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const query of [original, ...planned]) {
    const normalized = query.trim().replace(/\s+/g, " ").slice(0, 2_000);
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    queries.push(normalized);
    if (queries.length >= maximum) break;
  }
  return queries;
}

export function feedbackRetrievalQueries(
  original: string,
  results: MemorySearchResult[],
  maximum: number,
): Array<{ query: string; excludedMemoryId: string }> {
  if (maximum <= 0) return [];
  const originalTerms = evidenceTerms(original);
  const queries: Array<{ query: string; excludedMemoryId: string }> = [];
  const seen = new Set<string>();
  for (const result of results) {
    const evidence = result.evidence.trim();
    if (!evidence) continue;
    const excerpt = feedbackEvidenceExcerpt(original, evidence);
    const hasNovelTerm = [...evidenceTerms(excerpt)].some(
      (term) => term.length > 2 && !feedbackStopWords.has(term) && !originalTerms.has(term),
    );
    if (!hasNovelTerm) continue;
    const query = `${original.slice(0, 1_000)}\n${excerpt}`.trim().replace(/\s+/g, " ");
    const key = query.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ query, excludedMemoryId: result.memory.id });
    if (queries.length >= maximum) break;
  }
  return queries;
}

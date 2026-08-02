// Does the query name a page? A person browsing their own notes thinks in note
// names, and a page whose title IS the query can otherwise lose two rank-fusion
// arms to one that merely mentions the words.
//
// The load-bearing parts here are STRUCTURAL, not tuned: matching on token
// boundaries so "art" cannot match "Bartholomew", and a two-content-token floor
// so a query of "the" cannot promote every page that has "the" in its title.
// Those rules are why this is safe to keep without an eval to calibrate it —
// unlike a weight, a wrong boundary rule fails visibly at rank 1.

import { normalizeRef } from "./pipeline";

// Words that carry no naming intent. Deliberately short: this is a floor
// against pathological queries, not a stemming pipeline.
const STOP = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

// Scripts without spaces between words (CJK, Thai, …) cannot be tokenized this
// way, so those titles are compared as substrings instead.
const UNSEGMENTED = /[　-鿿가-힯฀-๿]/;

function tokens(text: string): string[] {
  return normalizeRef(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function contentTokens(text: string): string[] {
  return tokens(text).filter((t) => !STOP.has(t));
}

// True when `needle` appears in `haystack` as a contiguous run of whole tokens.
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

// A title-phrase match means the query names this page: either the whole title
// appears in the query, or the whole query appears in the title. Both directions
// matter — "hybrid search" should match the page titled "Hybrid search", and
// "who owns hybrid search" should too.
export function isTitlePhraseMatch(query: string, title: string): boolean {
  const q = normalizeRef(query);
  const t = normalizeRef(title);
  if (!q || !t) return false;
  if (q === t) return true;

  if (UNSEGMENTED.test(t) || UNSEGMENTED.test(q)) {
    // No token boundaries to lean on: require a substantial substring so a
    // single shared character cannot promote a page.
    const short = q.length <= t.length ? q : t;
    const long = q.length <= t.length ? t : q;
    return short.length >= 2 && long.includes(short);
  }

  const qt = contentTokens(q);
  const tt = contentTokens(t);
  // The floor: a one-token title or query is too weak a signal to boost on
  // unless it is an exact match, which the equality check above already caught.
  if (qt.length < 2 || tt.length < 2) return false;
  return containsTokenRun(qt, tt) || containsTokenRun(tt, qt);
}

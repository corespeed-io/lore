// Mention linking: a note that merely NAMES another note gets an edge, without
// anything rewriting the user's text.
//
// Deterministic, zero-LLM, auditable, and reversible — it writes only
// lane='auto', so `DELETE FROM edges WHERE lane='auto'` undoes every inference
// it ever made. It never touches the declared lane, which is what lets the UI
// style inferred edges differently and lets a person tell their own links from
// a heuristic's.
//
// Four choices carry the safety, and none of them is a tuned weight:
//   1. The gazetteer is built only from SLUG-PREFIXED typed pages (people/,
//      companies/, entities/, concepts/) plus their aliases. A page called
//      "Notes" or "Work" is not under one of those prefixes, so it cannot link
//      from everywhere. This replaces gbrain's hand-maintained ambiguous-word
//      ignore list (Apple/Box/Meta/…): that list exists to stop bare words
//      resolving to pages that do not exist, and every name here belongs to a
//      page that does.
//   2. MIN_NAME_LENGTH — short names under-link. That is the right trade in a
//      matcher with no eval: a false auto-edge pollutes the graph until someone
//      notices, a missing one is merely invisible.
//   3. Longest match wins (maximal munch), so "Robert Smith" does not also
//      produce an edge to a page named "Robert".
//   4. One edge per page pair, and never to itself.
// Fenced and inline code is masked first, for the same reason declared-link
// extraction masks it.

import { maskCode, normalizeRef } from "./pipeline";

export const MIN_NAME_LENGTH = 4;

// Only these prefixes contribute names. Mirrors the types the store already
// infers from a slug, so "typed page" means one thing in this codebase.
export const GAZETTEER_PREFIXES = ["people/", "companies/", "entities/", "concepts/"];

export interface GazetteerEntry {
  pageId: number;
  /** Normalized surface form to look for. */
  name: string;
}

export interface NamedPage {
  id: number;
  slug: string;
  title: string;
  aliases?: string[];
}

// Longest names first so a scan can take the longest match at each position.
export function buildGazetteer(pages: NamedPage[]): GazetteerEntry[] {
  const out = new Map<string, GazetteerEntry>();
  for (const page of pages) {
    if (!GAZETTEER_PREFIXES.some((p) => page.slug.startsWith(p))) continue;
    for (const raw of [page.title, ...(page.aliases ?? [])]) {
      const name = normalizeRef(raw ?? "");
      if (name.length < MIN_NAME_LENGTH) continue;
      // A name shared by two pages is ambiguous; the shorter slug wins, which
      // is the same stable tie-break resolveRef uses.
      const prior = out.get(name);
      if (!prior || page.slug.length < (pages.find((p) => p.id === prior.pageId)?.slug.length ?? 0))
        out.set(name, { pageId: page.id, name });
    }
  }
  return [...out.values()].sort((a, b) => b.name.length - a.name.length);
}

// Scripts without spaces cannot use word boundaries; those names are matched as
// plain substrings instead.
const UNSEGMENTED = /[　-鿿가-힯฀-๿]/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

// Which gazetteer pages does this text name? Returns page ids, deduped.
// The text is normalized the same way the names are, so a match is a match on
// both sides — the failure mode of two different normalizers is silence.
export function findMentions(text: string, gazetteer: GazetteerEntry[]): number[] {
  // Code is not prose: a note documenting `[[Wanda Ford]]` syntax, or pasting a
  // config that happens to list company names, must not grow edges from it.
  // Same masker the declared-link extractor uses.
  const hay = normalizeRef(maskCode(text));
  if (!hay) return [];
  const hits = new Set<number>();
  // Positions already consumed by a longer name, so "Robert Smith" does not
  // also yield "Robert".
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && end > s);

  for (const entry of gazetteer) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(entry.name, from);
      if (at === -1) break;
      const end = at + entry.name.length;
      const segmented = !UNSEGMENTED.test(entry.name);
      const boundedLeft = !segmented || !isWordChar(hay[at - 1]);
      const boundedRight = !segmented || !isWordChar(hay[end]);
      if (boundedLeft && boundedRight && !overlaps(at, end)) {
        hits.add(entry.pageId);
        taken.push([at, end]);
      }
      from = at + 1;
    }
  }
  return [...hits];
}

import { expect, test } from "vitest";
import { isTitlePhraseMatch } from "../src/server/title-match.js";

test("matches a title the query names, in either direction", () => {
  expect(isTitlePhraseMatch("hybrid search", "Hybrid search")).toBe(true);
  expect(isTitlePhraseMatch("who owns hybrid search", "Hybrid search")).toBe(true);
  expect(isTitlePhraseMatch("Hybrid search and other things", "Hybrid search")).toBe(true);
  // case, punctuation and spacing are folded by the shared normalizer
  expect(isTitlePhraseMatch("  HYBRID   Search ", "hybrid search")).toBe(true);
});

test("token boundaries: a substring is not a name match", () => {
  // The rule that makes this boost safe without an eval to calibrate it.
  expect(isTitlePhraseMatch("art", "Bartholomew")).toBe(false);
  expect(isTitlePhraseMatch("art history", "Bartholomew Smith")).toBe(false);
  expect(isTitlePhraseMatch("cat", "concatenate strings")).toBe(false);
});

test("a single weak token cannot promote anything", () => {
  // Two-content-token floor: "the" appears in half the titles in any vault.
  expect(isTitlePhraseMatch("the", "The Reading List")).toBe(false);
  expect(isTitlePhraseMatch("notes", "Notes on retrieval")).toBe(false);
  expect(isTitlePhraseMatch("of the", "History of the World")).toBe(false);
  // ...unless it is exactly the title, which is not a guess about intent
  expect(isTitlePhraseMatch("notes", "Notes")).toBe(true);
});

test("stop words do not count toward the floor", () => {
  // "who owns" is one content token after stops; the TITLE supplies two.
  expect(isTitlePhraseMatch("who is jane doe", "Jane Doe")).toBe(true);
  expect(isTitlePhraseMatch("what about the memory system", "Memory system")).toBe(true);
});

test("unsegmented scripts fall back to substring, with a length floor", () => {
  expect(isTitlePhraseMatch("记忆系统", "记忆系统设计")).toBe(true);
  expect(isTitlePhraseMatch("记忆系统设计怎么做", "记忆系统设计")).toBe(true);
  // a single shared character is not a name match
  expect(isTitlePhraseMatch("系", "记忆系统设计")).toBe(false);
  expect(isTitlePhraseMatch("完全无关的内容", "记忆系统设计")).toBe(false);
});

test("empty and degenerate input is not a match", () => {
  expect(isTitlePhraseMatch("", "Anything")).toBe(false);
  expect(isTitlePhraseMatch("something", "")).toBe(false);
  expect(isTitlePhraseMatch("   ", "Anything")).toBe(false);
});

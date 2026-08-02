import { expect, test } from "vitest";
import { MIN_NAME_LENGTH, buildGazetteer, findMentions } from "../src/server/mentions.js";

const PAGES = [
  { id: 1, slug: "people/robert-smith", title: "Robert Smith", aliases: ["bobby"] },
  { id: 2, slug: "people/robert", title: "Robert" },
  { id: 3, slug: "companies/acme-corp", title: "Acme Corp" },
  { id: 4, slug: "concepts/hybrid-search", title: "Hybrid search" },
  { id: 5, slug: "entities/记忆系统", title: "记忆系统" },
  // NOT a typed prefix: a page like this must never link from everywhere.
  { id: 6, slug: "notes/notes", title: "Notes" },
  { id: 7, slug: "people/al", title: "Al" }, // shorter than MIN_NAME_LENGTH
];

test("the gazetteer only takes typed pages with long-enough names", () => {
  const g = buildGazetteer(PAGES);
  const names = g.map((e) => e.name);
  expect(names).toContain("robert smith");
  expect(names).toContain("acme corp");
  expect(names).toContain("bobby"); // aliases count
  expect(names).toContain("记忆系统");
  // an untyped page cannot contribute a name, however common the word
  expect(names).not.toContain("notes");
  // and a name shorter than the floor is skipped
  expect(names).not.toContain("al");
  expect(MIN_NAME_LENGTH).toBe(4);
  // longest first, so a scan can take maximal munch
  expect(names[0].length).toBeGreaterThanOrEqual(names[names.length - 1].length);
});

test("a note that names another note yields exactly that edge", () => {
  const g = buildGazetteer(PAGES);
  expect(findMentions("met Robert Smith at Acme Corp today", g).sort()).toEqual([1, 3]);
  expect(findMentions("nothing here names anything", g)).toEqual([]);
});

test("longest match wins, so a longer name does not also match a shorter one", () => {
  const g = buildGazetteer(PAGES);
  // "Robert Smith" must NOT also produce an edge to the page titled "Robert"
  expect(findMentions("spoke to Robert Smith", g)).toEqual([1]);
  // but a bare "Robert" still resolves to its own page
  expect(findMentions("spoke to Robert alone", g)).toEqual([2]);
});

test("token boundaries: a name inside a longer word is not a mention", () => {
  const g = buildGazetteer([{ id: 10, slug: "people/bart", title: "Bart" }]);
  expect(findMentions("Bartholomew was there", g)).toEqual([]);
  expect(findMentions("Bart was there", g)).toEqual([10]);
  expect(findMentions("(Bart)", g)).toEqual([10]);
});

test("unsegmented names match as substrings", () => {
  const g = buildGazetteer(PAGES);
  expect(findMentions("我们在讨论记忆系统的设计", g)).toEqual([5]);
});

test("a page naming itself is the caller's job to skip, and dedupes", () => {
  const g = buildGazetteer(PAGES);
  // repeated mentions of one page yield one id
  expect(findMentions("Acme Corp and Acme Corp again", g)).toEqual([3]);
});

test("code is not prose: a name inside code is not a mention", () => {
  const g = buildGazetteer(PAGES);
  expect(findMentions("To link, write `[[Robert Smith]]` in a note.", g)).toEqual([]);
  expect(findMentions("```\ncustomer: Acme Corp\n```", g)).toEqual([]);
  // ...but the same name in prose still counts
  expect(findMentions("Acme Corp signed today.", g)).toEqual([3]);
});

// The summarizer a deployment gets when it has not configured a model.
//
// Deliberately extractive rather than generative: it selects and structures what
// the user actually said instead of paraphrasing it. That keeps the default
// install model-free and honest — a summary can be wrong about STRUCTURE here,
// but it cannot invent content. Swap in a model-backed Summarizer behind the same
// interface when one is available.

import type { Summarizer } from "./summary";
import { EMPTY_SUMMARY } from "./summary";

const CORRECTION = /\b(?:correction|actually|instead|i meant|not (?:a|the)|rather than|no[,—-])\b/i;
const REQUIREMENT = /\b(?:must|need to|should|require|has to|make sure)\b/i;
const CONSTRAINT = /\b(?:cannot|can't|do not|don't|never|avoid|without|only)\b/i;
const BLOCKER = /\b(?:blocked|stuck|waiting on|can't proceed|fails|failing)\b/i;
const QUESTION = /\?\s*$/;
const DONE = /\b(?:done|finished|completed|shipped|merged|landed)\b/i;

// Each ITEM is bounded too, not just the list. Capping the list at 12 while every
// item could be 400KB bounds the wrong dimension: one append_event with a large
// payload field produced an ~800KB rendered_summary, which every later version
// folds forward in a table nothing prunes.
const MAX_ITEM = 400;
const item = (v: string): string => (v.length <= MAX_ITEM ? v : `${v.slice(0, MAX_ITEM)}…`);

function dedupePush(list: string[], value: string, cap = 12): void {
  const v = item(value.trim());
  if (!v || list.includes(v)) return;
  list.push(v);
  // Bounded so a long thread cannot grow the summary without limit; the oldest
  // entries fall off, which is the same trade a rolling summary always makes.
  while (list.length > cap) list.shift();
}

export const extractiveSummarizer: Summarizer = {
  version: "extractive-1",
  async summarize({ previous, events }) {
    const next = {
      ...EMPTY_SUMMARY,
      ...previous,
      background: [...previous.background],
      requirements: [...previous.requirements],
      constraints: [...previous.constraints],
      decisions: [...previous.decisions],
      corrections: [...previous.corrections],
      completed: [...previous.completed],
      artifacts: [...previous.artifacts],
      open_questions: [...previous.open_questions],
      blockers: [...previous.blockers],
    };

    for (const e of events) {
      const text = e.content.trim();
      if (!text) continue;

      if (e.event_type === "artifact") {
        const name = String(e.structured_payload?.name ?? text.slice(0, 60));
        const reference = String(e.structured_payload?.reference ?? "");
        const type = String(e.structured_payload?.type ?? "artifact");
        // artifacts and corrections were the two lists with no cap at all.
        if (!next.artifacts.some((a) => a.name === name && a.reference === reference)) {
          next.artifacts.push({ name: item(name), reference: item(reference), type: item(type) });
          while (next.artifacts.length > 12) next.artifacts.shift();
        }
        continue;
      }
      if (e.event_type === "approval") {
        next.decisions.push({ value: text, status: "confirmed" });
        continue;
      }
      if (e.event_type === "assistant_message") {
        // A suggestion is PROPOSED. Only the user confirms.
        next.decisions.push({ value: text.slice(0, 200), status: "proposed" });
        continue;
      }
      if (e.event_type === "tool_result") {
        if (BLOCKER.test(text)) dedupePush(next.blockers, text.slice(0, 200));
        continue;
      }
      if (e.event_type !== "user_message") continue;

      if (CORRECTION.test(text)) {
        // The latest explicit correction REPLACES current state; the outdated
        // version is kept as a correction record, not as a live requirement.
        if (next.goal && next.goal !== text) {
          next.corrections.push({ old: item(next.goal), new: item(text) });
          while (next.corrections.length > 12) next.corrections.shift();
        }
        next.goal = text;
        // A corrected goal invalidates requirements phrased against the old one.
        next.requirements = next.requirements.filter(
          (r) => !next.corrections.some((c) => c.old === r),
        );
        continue;
      }
      if (!next.goal) {
        next.goal = text;
        continue;
      }
      if (QUESTION.test(text)) dedupePush(next.open_questions, text);
      else if (DONE.test(text)) dedupePush(next.completed, text);
      else if (CONSTRAINT.test(text)) dedupePush(next.constraints, text);
      else if (REQUIREMENT.test(text)) dedupePush(next.requirements, text);
      else dedupePush(next.background, text);
    }

    // Decisions are capped the same way, newest kept.
    while (next.decisions.length > 12) next.decisions.shift();
    next.next_action = next.blockers.length
      ? `Resolve: ${next.blockers[next.blockers.length - 1]}`
      : next.goal
        ? `Act on: ${next.goal}`
        : "";
    return next;
  },
};

// One place decides which summarizer is in play, so a deployment can swap it
// without touching the memory system.
export function summarizerFromEnv(): Summarizer {
  return extractiveSummarizer;
}

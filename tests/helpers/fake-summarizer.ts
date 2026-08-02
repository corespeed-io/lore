// A deterministic summarizer for tests. Same inputs, same output, no model — so a
// summary assertion is about the summary LOGIC (incremental folding, versioning,
// corrections replacing current state) rather than about a provider's mood.
//
// It is intentionally simple-minded: it reads user messages, treats the newest
// goal-shaped statement as the goal, records a correction when the user
// contradicts, and files assistant suggestions as `proposed` rather than
// `confirmed`.

import type { Summarizer } from "../../src/server/memory/summary.js";
import { EMPTY_SUMMARY } from "../../src/server/memory/summary.js";

const CORRECTION = /\b(?:correction|actually|no[—,-]|not a|i meant|instead)\b/i;

export const fakeSummarizer: Summarizer = {
  version: "fake-1",
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
      if (e.event_type === "assistant_message") {
        // A suggestion is not a decision the user made.
        next.decisions.push({ value: text, status: "proposed" });
        continue;
      }
      if (e.event_type !== "user_message") continue;
      if (CORRECTION.test(text)) {
        // The latest explicit correction REPLACES current state rather than
        // being appended as another equally-valid opinion.
        if (next.goal) next.corrections.push({ old: next.goal, new: text });
        next.goal = text;
        continue;
      }
      if (!next.goal) next.goal = text;
      else next.requirements.push(text);
    }
    next.next_action = next.goal ? `Act on: ${next.goal}` : "";
    return next;
  },
};

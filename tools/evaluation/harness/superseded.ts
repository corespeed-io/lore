import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import {
  isLongMemEvalAbstention,
  type LongMemEvalRecord,
  longMemEvalManifest,
  longMemEvalSessionKeys,
  parseLongMemEvalRecord,
} from "../retrieval/longmemeval";
import { longMemEvalSessionTime } from "./datasets";
import type { EvalStore } from "./store";
import { systemDatabases } from "./system-common";
import { memorySearchSystem } from "./systems";
import type { EvalCase, EvalSystem, EvalUnit, Packet, PacketItem, SystemContext } from "./types";

const THIS_FILE = fileURLToPath(import.meta.url);

/** One gold session of a knowledge-update question: where its value was said, and when. */
interface UpdateSession {
  key: string;
  occurredAt: string;
  answerTurns: string[];
}

/** A knowledge-update question's old and new value, from the dataset's gold sessions. */
interface KnowledgeUpdate {
  older: UpdateSession;
  newer: UpdateSession;
}

/**
 * Experiment: an upper bound for a Memory's validUntil. LongMemEval-S gives each
 * knowledge-update question two gold sessions, the old value and the new one. This
 * system plays a perfect writer that superseded the old value with the new one:
 * - `mark`: a passage that states the old value carries valid-until (the new
 *   value's time) and superseded-by, as a search hit would carry them;
 * - `follow`: also, when the new value's passage is not in the packet, it is added
 *   right after the old one, as a search that follows supersedes Links would add it.
 * Every other question and passage is exactly memory-search's, from its corpus.
 */
export function supersededMemorySearchSystem(options: {
  store: EvalStore;
  geminiApiKey: string;
  mode: "mark" | "follow";
}): EvalSystem {
  const base = memorySearchSystem(options);
  const databases = systemDatabases();
  let updates: Map<string, KnowledgeUpdate> | undefined;
  const updateFor = (unitKey: string) => {
    updates ??= knowledgeUpdates();
    return updates.get(unitKey);
  };
  return {
    ...base,
    id: options.mode === "mark" ? "memory-search-superseded" : "memory-search-superseded-follow",
    runEntries: [...base.runEntries, THIS_FILE],
    retrievalIdentity: () => ({
      ...base.retrievalIdentity(),
      supersession: `ground-truth-${options.mode}-v1`,
    }),

    async retrieve(context: SystemContext, unit: EvalUnit, evalCase: EvalCase): Promise<Packet> {
      const packet = await base.retrieve(context, unit, evalCase);
      const update = updateFor(unit.key);
      if (!update) return packet;
      const states = (item: PacketItem, session: UpdateSession) =>
        item.sourceKeys[0] === session.key &&
        session.answerTurns.some((turn) => overlaps(item.text, turn));
      const newerPresent = packet.items.some((item) => states(item, update.newer));
      const items: PacketItem[] = [];
      let followed = false;
      for (const item of packet.items) {
        if (!states(item, update.older)) {
          items.push(item);
          continue;
        }
        items.push({
          ...item,
          validUntil: update.newer.occurredAt,
          supersededBy: `memory:${update.newer.key}`,
        });
        if (options.mode === "follow" && !newerPresent && !followed) {
          const text = await successorPassage(
            databases.connect(context.databaseUrl).admin,
            context.workspaceIdFor(unit),
            update.newer,
          );
          if (text) {
            items.push({
              id: `memory:${update.newer.key}`,
              text,
              occurredAt: update.newer.occurredAt,
              supersedes: `memory:${update.older.key}`,
              sourceKeys: [update.newer.key],
            });
            followed = true;
          }
        }
      }
      return { ...packet, items };
    },

    close: async () => {
      await base.close();
      await databases.close();
    },
  };
}

/** Whether a passage holds part of a turn: a 60-character window of it, or all of it. */
function overlaps(passage: string, turn: string): boolean {
  const text = turn.trim();
  if (text.length <= 60) return passage.includes(text);
  const middle = Math.floor(text.length / 2) - 30;
  return [0, middle, text.length - 60].some((start) =>
    passage.includes(text.slice(start, start + 60)),
  );
}

/** The new value's passage: the chunk of its session Memory that holds an answer turn. */
async function successorPassage(
  admin: pg.Pool,
  workspaceId: string,
  session: UpdateSession,
): Promise<string | null> {
  const { rows } = await admin.query<{ content: string }>(
    `SELECT chunk.content
     FROM memory_chunks chunk
     JOIN memories memory ON memory.id = chunk.memory_id AND memory.workspace_id = chunk.workspace_id
     WHERE memory.workspace_id = $1
       AND (memory.metadata->>'evalKey' = $2 OR memory.metadata->>'evalAnchorKey' = $2)
     ORDER BY memory.metadata->>'evalKey', chunk.ordinal`,
    [workspaceId, session.key],
  );
  return (
    rows.find((row) => session.answerTurns.some((turn) => overlaps(row.content, turn)))?.content ??
    null
  );
}

/** Every LongMemEval-S knowledge-update question's old and new gold session. */
function knowledgeUpdates(): Map<string, KnowledgeUpdate> {
  const file = longMemEvalManifest.files.s;
  const path = resolve("evaluation/datasets/longmemeval", file.filename);
  const records = (JSON.parse(readFileSync(path, "utf8")) as unknown[]).map(parseLongMemEvalRecord);
  const updates = new Map<string, KnowledgeUpdate>();
  for (const record of records) {
    if (record.question_type !== "knowledge-update" || isLongMemEvalAbstention(record)) continue;
    const sessions = goldSessions(record);
    if (sessions.length !== 2) continue;
    const [older, newer] = sessions.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    if (older && newer && older.occurredAt < newer.occurredAt) {
      updates.set(record.question_id, { older, newer });
    }
  }
  return updates;
}

function goldSessions(record: LongMemEvalRecord): UpdateSession[] {
  const { keys } = longMemEvalSessionKeys(record);
  const gold = new Set(record.answer_session_ids);
  const sessions: UpdateSession[] = [];
  record.haystack_session_ids.forEach((id, index) => {
    const answerTurns = (record.haystack_sessions[index] ?? [])
      .filter((turn) => turn.has_answer === true && turn.content.trim())
      .map((turn) => turn.content);
    const key = keys[index];
    const date = record.haystack_dates[index];
    if (gold.has(id) && answerTurns.length && key && date) {
      sessions.push({ key, occurredAt: longMemEvalSessionTime(date), answerTurns });
    }
  });
  return sessions;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import type pg from "pg";
import { createMemoryModule } from "../../../src/modules/memories/service";
import { createGoogleEmbeddingProvider } from "../../../src/server/providers/embedding/google";
import { strictRetrievalKnobsFromEnvironment } from "../../../src/server/providers/retrieval-knobs";
import { renderBenchmarkReaderInput } from "../shared/benchmark-reader";
import { longMemEvalS } from "./datasets";
import { cachedEmbeddingProvider } from "./embedding-cache";
import { identityHash, sha256 } from "./hash";
import type { EvalStore } from "./store";
import { ALICE, EMBEDDING_SPACE, systemDatabases } from "./system-common";
import { memorySearchSystem } from "./systems";
import { selectTier } from "./tiers";
import type { EvalCase, EvalSystem, EvalUnit, Packet, PacketItem, SystemContext } from "./types";

const THIS_FILE = fileURLToPath(import.meta.url);
export const WRITER_MODEL = "gemini-3.5-flash";
export const MAXIMUM_CLAIMS = 5;
const CANDIDATES_PER_CLAIM = 5;
export const SESSION_CHARACTERS = 30_000;
const MAXIMUM_FOLLOWED = 3;
const SESSIONS_AT_ONCE = 4;

export const SYSTEM_INSTRUCTION =
  "You maintain a long-term memory for one user. You read their conversations with an assistant and keep track of facts about the user. Answer with JSON only.";

export const EXTRACT_TASK = `From this conversation session, list the facts the user states about their own life that have a specific value someone could later need: a number or count, where something is kept, a status, a plan, a possession, a routine, a preference, or a correction of something earlier. Include facts the user mentions only in passing (for example, "by the way, ..."). Ignore general knowledge, questions, and the assistant's advice. Write each as one short standalone sentence that keeps the specific value. Return only a JSON array of at most ${MAXIMUM_CLAIMS} strings, or [] if there are none.`;

const DECIDE_TASK =
  'The item "claim" is a new fact from the user\'s newest session. The other evidence items are passages from the user\'s earlier sessions, each with its Memory id. Decide whether an earlier passage states an older value of the same fact about the same thing, which the new fact now replaces: the same attribute changed (for example, a count, where something is kept, a status, a plan). Do not count related but different facts, or the same value repeated. Return only a JSON object {"replaces": [<Memory ids>]}, with an empty list when the new fact replaces nothing.';

/** One link the writer recorded: the newer session's Memory replaces the older one's fact. */
interface WrittenLink {
  newer: string;
  older: string;
  claim: string;
}

interface UnitSession {
  key: string;
  occurredAt: string;
  text: string;
}

/**
 * Experiment: a realistic writer for supersession. An LLM plays the writing agent:
 * for each session in order, it lists the facts that may update earlier ones, searches
 * Lore for earlier sessions, and records which Memory each fact replaces. Search then
 * follows those links as in the upper bound: a retrieved replaced passage carries
 * valid-until and superseded-by, and the replacing Memory's closest passage follows it
 * when it is not already in the packet. The writer runs on every knowledge-update
 * question and the standard tier of the others; every other question is unchanged.
 */
export function writtenSupersessionSystem(options: {
  store: EvalStore;
  geminiApiKey: string;
}): EvalSystem {
  const base = memorySearchSystem(options);
  const databases = systemDatabases();
  const { provider } = cachedEmbeddingProvider(
    createGoogleEmbeddingProvider(EMBEDDING_SPACE, { apiKey: options.geminiApiKey, maxRetries: 5 }),
    options.store,
  );
  const knobs = strictRetrievalKnobsFromEnvironment({});
  const client = new GoogleGenAI({ apiKey: options.geminiApiKey });
  let skipped = 0;
  const writerIdentity = identityHash({
    model: WRITER_MODEL,
    system: sha256(SYSTEM_INSTRUCTION),
    extract: sha256(EXTRACT_TASK),
    decide: sha256(DECIDE_TASK),
    claims: MAXIMUM_CLAIMS,
    candidates: CANDIDATES_PER_CLAIM,
    sessionCharacters: SESSION_CHARACTERS,
  }).slice(0, 16);
  const cacheDirectory = resolve("evaluation/results/supersession-writer", writerIdentity);
  let writerUnits: Promise<Set<string>> | undefined;
  const pending = new Map<string, Promise<WrittenLink[]>>();

  /** The writer's JSON answer, or null when it still fails after retries (counted). */
  async function ask(task: string, evidence: Array<{ id: string; text: string }>) {
    const input = renderBenchmarkReaderInput(task, evidence, 60_000);
    let last = "";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const payload = await client.interactions.create(
          {
            model: WRITER_MODEL,
            input,
            system_instruction: SYSTEM_INSTRUCTION,
            store: false,
            stream: false,
            generation_config: { max_output_tokens: 8192 },
          },
          {
            maxRetries: 0,
            timeout: 180_000,
            body: { generation_config: { temperature: 0, max_output_tokens: 8192 } },
          },
        );
        const steps = Array.isArray(payload.steps) ? payload.steps : [];
        const text = steps
          .flatMap((step) =>
            step && typeof step === "object" && "content" in step && Array.isArray(step.content)
              ? step.content
              : [],
          )
          .map((part) =>
            part && typeof part === "object" && "text" in part && typeof part.text === "string"
              ? part.text
              : "",
          )
          .join("");
        return parseJson(text);
      } catch (error) {
        last = String((error as { message?: unknown }).message ?? error).slice(0, 300);
        await new Promise((done) => setTimeout(done, 2_000 * attempt));
      }
    }
    skipped += 1;
    process.stderr.write(`[writer] skipped a call after 4 attempts (${skipped} so far): ${last}\n`);
    return null;
  }

  async function writeLinks(context: SystemContext, unit: EvalUnit): Promise<WrittenLink[]> {
    const path = join(cacheDirectory, `${unit.key}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as WrittenLink[];
    const workspaceId = context.workspaceIdFor(unit);
    const memories = createMemoryModule(databases.connect(context.databaseUrl).request, {
      ...knobs,
      embeddingDimensions: EMBEDDING_SPACE.dimensions,
      embeddingProvider: provider,
    });
    const sessions = unitSessions(unit);
    const links: WrittenLink[] = [];
    const trace: Array<{
      session: string;
      claims: string[];
      candidates: string[];
      decided: unknown;
    }> = [];
    const work = sessions.map((session) => async () => {
      const claims = asStrings(
        await ask(EXTRACT_TASK, [
          { id: session.key, text: session.text.slice(0, SESSION_CHARACTERS) },
        ]),
      ).slice(0, MAXIMUM_CLAIMS);
      if (!claims.length) return;
      // One search and one decision per claim, as an agent writing that fact would.
      for (const claim of claims) {
        const results = await memories.search(
          { workspaceId, userId: ALICE },
          { query: claim, limit: 10, metadataFilter: { evalUnit: unit.key } },
        );
        const candidates = new Map<string, { key: string; text: string; occurredAt: string }>();
        for (const result of results) {
          const metadata = result.memory.metadata as Record<string, unknown>;
          const key = String(metadata.evalAnchorKey ?? metadata.evalKey ?? "");
          const occurredAt = result.memory.occurredAt;
          // Only earlier sessions: the writer knows nothing that came later.
          if (!key || key === session.key || !occurredAt || occurredAt >= session.occurredAt) {
            continue;
          }
          const id = `${key}#${sha256(result.evidence).slice(0, 8)}`;
          if (!candidates.has(id)) candidates.set(id, { key, text: result.evidence, occurredAt });
          if (candidates.size >= CANDIDATES_PER_CLAIM) break;
        }
        if (!candidates.size) {
          trace.push({ session: session.key, claims: [claim], candidates: [], decided: null });
          continue;
        }
        const decided = await ask(DECIDE_TASK, [
          { id: "claim", text: `New fact (session of ${session.occurredAt}): ${claim}` },
          ...[...candidates].map(([id, candidate]) => ({
            id,
            text: `Earlier session of ${candidate.occurredAt}:\n${candidate.text}`,
          })),
        ]);
        trace.push({
          session: session.key,
          claims: [claim],
          candidates: [...candidates.keys()],
          decided,
        });
        const replaces =
          decided && typeof decided === "object" && "replaces" in decided
            ? (decided as { replaces?: unknown }).replaces
            : [];
        for (const id of Array.isArray(replaces) ? replaces : []) {
          const candidate = candidates.get(String(id));
          if (
            candidate &&
            !links.some((link) => link.older === candidate.key && link.newer === session.key)
          ) {
            links.push({ newer: session.key, older: candidate.key, claim });
          }
        }
      }
    });
    await inParallel(work, SESSIONS_AT_ONCE);
    mkdirSync(cacheDirectory, { recursive: true });
    writeFileSync(path, JSON.stringify(links, null, 2));
    writeFileSync(path.replace(/\.json$/, ".trace.json"), JSON.stringify(trace, null, 2));
    return links;
  }

  return {
    ...base,
    id: "memory-search-written-supersession",
    runEntries: [...base.runEntries, THIS_FILE],
    retrievalIdentity: () => ({ ...base.retrievalIdentity(), supersessionWriter: writerIdentity }),

    async retrieve(context: SystemContext, unit: EvalUnit, evalCase: EvalCase): Promise<Packet> {
      const packet = await base.retrieve(context, unit, evalCase);
      writerUnits ??= unitsToWrite();
      if (!(await writerUnits).has(unit.key)) return packet;
      let written = pending.get(unit.key);
      if (!written) {
        written = writeLinks(context, unit);
        pending.set(unit.key, written);
      }
      const links = await written;
      if (!links.length) return packet;
      const sessions = new Map(unitSessions(unit).map((session) => [session.key, session]));
      const present = new Set(packet.items.flatMap((item) => item.sourceKeys));
      const items: PacketItem[] = [];
      let followed = 0;
      for (const item of packet.items) {
        const replaced = links.filter((link) => link.older === item.sourceKeys[0]);
        // The newest replacement is the one that says what holds now.
        const newest = replaced
          .map((link) => ({ link, session: sessions.get(link.newer) }))
          .filter((entry) => entry.session)
          .sort((a, b) =>
            (b.session?.occurredAt ?? "").localeCompare(a.session?.occurredAt ?? ""),
          )[0];
        if (!newest?.session) {
          items.push(item);
          continue;
        }
        items.push({
          ...item,
          validUntil: newest.session.occurredAt,
          supersededBy: `memory:${newest.session.key}`,
        });
        if (followed < MAXIMUM_FOLLOWED && !present.has(newest.session.key)) {
          const text = await closestPassage(
            databases.connect(context.databaseUrl).admin,
            context.workspaceIdFor(unit),
            newest.session.key,
            newest.link.claim,
          );
          if (text) {
            items.push({
              id: `memory:${newest.session.key}`,
              text,
              occurredAt: newest.session.occurredAt,
              supersedes: `memory:${item.sourceKeys[0]}`,
              sourceKeys: [newest.session.key],
            });
            present.add(newest.session.key);
            followed += 1;
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

/** Every knowledge-update question, and the standard tier of every category. */
async function unitsToWrite(): Promise<Set<string>> {
  const index = await longMemEvalS().index();
  const units = selectTier(index, "standard");
  for (const entry of index) if (entry.category === "knowledge-update") units.add(entry.id);
  return units;
}

/** A Unit's sessions in time order, each whole, its parts joined. */
function unitSessions(unit: EvalUnit): UnitSession[] {
  const sessions = new Map<string, UnitSession>();
  for (const record of unit.records) {
    const key = record.anchorKey ?? record.key;
    const existing = sessions.get(key);
    if (existing) existing.text = `${existing.text}\n\n${record.text}`;
    else sessions.set(key, { key, occurredAt: record.occurredAt ?? "", text: record.text });
  }
  return [...sessions.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/** The replacing Memory's chunk that shares the most words with the claim that linked it. */
async function closestPassage(
  admin: pg.Pool,
  workspaceId: string,
  key: string,
  claim: string,
): Promise<string | null> {
  const { rows } = await admin.query<{ content: string }>(
    `SELECT chunk.content
     FROM memory_chunks chunk
     JOIN memories memory ON memory.id = chunk.memory_id AND memory.workspace_id = chunk.workspace_id
     WHERE memory.workspace_id = $1
       AND (memory.metadata->>'evalKey' = $2 OR memory.metadata->>'evalAnchorKey' = $2)
     ORDER BY memory.metadata->>'evalKey', chunk.ordinal`,
    [workspaceId, key],
  );
  const words = new Set(claim.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  let best: { content: string; score: number } | null = null;
  for (const row of rows) {
    const score = (row.content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) =>
      words.has(word),
    ).length;
    if (!best || score > best.score) best = { content: row.content, score };
  }
  return best?.content ?? null;
}

function parseJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf("]"), trimmed.lastIndexOf("}"));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`The writer did not answer JSON: ${trimmed.slice(0, 200)}`);
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

async function inParallel(work: Array<() => Promise<void>>, width: number): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, work.length) }, async () => {
      while (next < work.length) {
        const index = next;
        next += 1;
        await work[index]?.();
      }
    }),
  );
}

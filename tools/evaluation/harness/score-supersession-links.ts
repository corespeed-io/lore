/**
 * Experiment: score the supersession writer's cached links. For each knowledge-update
 * question it reports whether the writer linked the newer gold session to the older
 * one, and per question type how many links it wrote (links outside knowledge-update
 * questions are candidates for false links).
 *
 *   bun --no-env-file tools/evaluation/harness/score-supersession-links.ts [writer-identity...]
 *
 * Reads evaluation/results/supersession-writer/<identity>/<question>.json from the
 * current checkout; with no identity it scores every cached one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type LongMemEvalRecord,
  longMemEvalManifest,
  longMemEvalSessionKeys,
  parseLongMemEvalRecord,
} from "../retrieval/longmemeval";
import { longMemEvalSessionTime } from "./datasets";

interface WrittenLink {
  newer: string;
  older: string;
  claim: string;
}

const base = resolve("evaluation/results/supersession-writer");
if (!existsSync(base)) throw new Error(`${base} holds no writer cache`);
const records = (
  JSON.parse(
    readFileSync(
      resolve("evaluation/datasets/longmemeval", longMemEvalManifest.files.s.filename),
      "utf8",
    ),
  ) as unknown[]
).map(parseLongMemEvalRecord);
const byId = new Map(records.map((record) => [record.question_id, record]));
const identities = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(base);
const mean = (values: number[]) =>
  (values.reduce((sum, value) => sum + value, 0) / (values.length || 1)).toFixed(1);

/** The question's older and newer gold session keys, by session time. */
function goldPair(record: LongMemEvalRecord): { older?: string; newer?: string } {
  const { keys } = longMemEvalSessionKeys(record);
  const gold = record.haystack_session_ids
    .map((id, index) => ({ id, key: keys[index], date: record.haystack_dates[index] ?? "" }))
    .filter((entry) => record.answer_session_ids.includes(entry.id))
    .sort((a, b) => longMemEvalSessionTime(a.date).localeCompare(longMemEvalSessionTime(b.date)));
  return { older: gold[0]?.key, newer: gold.at(-1)?.key };
}

for (const identity of identities) {
  const directory = join(base, identity);
  const files = readdirSync(directory).filter(
    (file) => file.endsWith(".json") && !file.endsWith(".trace.json"),
  );
  const byType = new Map<string, number[]>();
  let updates = 0;
  let linked = 0;
  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    const record = byId.get(id);
    if (!record) continue;
    const links = JSON.parse(readFileSync(join(directory, file), "utf8")) as WrittenLink[];
    const counts = byType.get(record.question_type) ?? [];
    counts.push(links.length);
    byType.set(record.question_type, counts);
    if (record.question_type !== "knowledge-update" || id.endsWith("_abs")) continue;
    const { older, newer } = goldPair(record);
    const hit = links.some((link) => link.newer === newer && link.older === older);
    updates += 1;
    if (hit) linked += 1;
    console.log(`${id} ${hit ? "LINKED" : "missed"} · ${links.length} links · ${record.question}`);
  }
  const all = [...byType.values()].flat();
  console.log(`\n[${identity}] ${all.length} questions, mean ${mean(all)} links each`);
  for (const [type, counts] of byType) {
    console.log(`  ${type}: ${counts.length} questions, mean ${mean(counts)} links`);
  }
  console.log(`  knowledge-update gold link recall: ${linked}/${updates}\n`);
}

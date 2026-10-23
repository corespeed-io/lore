/**
 * Experiment: show the facts the supersession writer extracts from each gold session
 * of the given LongMemEval-S questions, and where each session's answer turn sits, to
 * tell an extraction miss from a search or decision miss.
 *
 *   GEMINI_API_KEY=… bun --no-env-file tools/evaluation/harness/inspect-supersession-claims.ts <question-id>...
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  longMemEvalManifest,
  parseLongMemEvalRecord,
  renderLongMemEvalSession,
} from "../retrieval/longmemeval";
import { renderBenchmarkReaderInput } from "../shared/benchmark-reader";
import {
  EXTRACT_TASK,
  SESSION_CHARACTERS,
  SYSTEM_INSTRUCTION,
  WRITER_MODEL,
} from "./supersession-writer";

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) throw new Error("GEMINI_API_KEY is required");
const client = new GoogleGenAI({ apiKey });
const records = (
  JSON.parse(
    readFileSync(
      resolve("evaluation/datasets/longmemeval", longMemEvalManifest.files.s.filename),
      "utf8",
    ),
  ) as unknown[]
).map(parseLongMemEvalRecord);

for (const id of process.argv.slice(2)) {
  const record = records.find((candidate) => candidate.question_id === id);
  if (!record) throw new Error(`No LongMemEval-S question ${id}`);
  console.log(`${id}: ${record.question} (gold: ${String(record.answer)})`);
  for (const sessionId of record.answer_session_ids) {
    const index = record.haystack_session_ids.indexOf(sessionId);
    const turns = record.haystack_sessions[index] ?? [];
    const text = renderLongMemEvalSession(record.haystack_dates[index] ?? "", turns);
    const answer = turns.find((turn) => turn.has_answer)?.content ?? "";
    const payload = await client.interactions.create(
      {
        model: WRITER_MODEL,
        input: renderBenchmarkReaderInput(
          EXTRACT_TASK,
          [{ id: sessionId, text: text.slice(0, SESSION_CHARACTERS) }],
          60_000,
        ),
        system_instruction: SYSTEM_INSTRUCTION,
        store: false,
        stream: false,
        generation_config: { max_output_tokens: 8192 },
      },
      { body: { generation_config: { temperature: 0, max_output_tokens: 8192 } } },
    );
    const output = (Array.isArray(payload.steps) ? payload.steps : [])
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
    console.log(
      `  ${sessionId} (${record.haystack_dates[index]}), ${text.length} characters, answer turn at ${text.indexOf(answer.slice(0, 40))}:`,
    );
    console.log(`  ${output.trim().replace(/\n/g, "\n  ")}`);
  }
}

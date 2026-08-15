import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetrievalPolicyTrace } from "./retrieval-policy-benchmark";
import { codexRetrievalPolicyToolFilter } from "./retrieval-policy-codex";

const fixturePath = fileURLToPath(
  new URL("../../packages/mcp/benchmark-fixture.ts", import.meta.url),
);
const outputSchemaPath = fileURLToPath(
  new URL("../fixtures/retrieval-policy-output.schema.json", import.meta.url),
);

const DISALLOWED_BUILTIN_TOOLS = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
].join(",");

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseFinalOutput(value: unknown): {
  outcome: RetrievalPolicyTrace["assistantOutcome"];
  answer: string;
} {
  const parsed =
    record(value) ??
    record(
      JSON.parse(
        String(value)
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, ""),
      ),
    );
  const outcome = parsed?.outcome;
  const answer = parsed?.answer;
  if (
    (outcome !== "answered" && outcome !== "clarified" && outcome !== "abstained") ||
    typeof answer !== "string"
  ) {
    throw new Error("Claude retrieval-policy output does not match its fixed schema");
  }
  return { outcome, answer };
}

function parseToolTrace(lines: readonly string[]) {
  return lines.filter(Boolean).map((line) => {
    const parsed = record(JSON.parse(line));
    if (!parsed || typeof parsed.name !== "string") {
      throw new Error("Claude retrieval-policy MCP trace is malformed");
    }
    return {
      name: parsed.name,
      arguments: record(parsed.arguments) ?? {},
      result: parsed.result,
    };
  });
}

export function parseClaudeRetrievalPolicyArtifacts(input: {
  resultEnvelopeJson: string;
  toolTraceJsonLines: readonly string[];
  latencyMs: number;
}): RetrievalPolicyTrace & { answer: string } {
  const envelope = record(JSON.parse(input.resultEnvelopeJson));
  if (!envelope || envelope.is_error === true) {
    throw new Error(
      `Claude retrieval-policy turn reported an error: ${JSON.stringify(envelope?.result ?? envelope)}`,
    );
  }
  const finalOutput = parseFinalOutput(envelope.structured_output ?? envelope.result);
  const usage = record(envelope.usage);
  return {
    assistantOutcome: finalOutput.outcome,
    answer: finalOutput.answer,
    latencyMs: input.latencyMs,
    inputTokens: nonnegativeNumber(usage?.input_tokens),
    outputTokens: nonnegativeNumber(usage?.output_tokens),
    toolCalls: parseToolTrace(input.toolTraceJsonLines),
  };
}

function jsonLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
}

async function readLinesWhenPresent(path: string): Promise<string[]> {
  try {
    return jsonLines(await readFile(path, "utf8"));
  } catch (error) {
    if (record(error)?.code === "ENOENT") return [];
    throw error;
  }
}

export interface ClaudeRetrievalPolicyTurnInput {
  model: string;
  prompt: string;
  toolNames: readonly string[];
  timeoutMs?: number;
}

export async function runClaudeRetrievalPolicyTurn(
  input: ClaudeRetrievalPolicyTurnInput,
): Promise<RetrievalPolicyTrace & { answer: string }> {
  const runDirectory = await mkdtemp(join(tmpdir(), "lore-retrieval-policy-claude."));
  const tracePath = join(runDirectory, "mcp-trace.jsonl");
  const mcpConfig = {
    mcpServers: {
      lore: {
        command: "bun",
        args: [fixturePath],
        env: {
          LORE_RETRIEVAL_POLICY_TOOLS: codexRetrievalPolicyToolFilter(input.toolNames),
          LORE_RETRIEVAL_POLICY_TRACE_PATH: tracePath,
        },
      },
    },
  };
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--json-schema",
    // Claude CLI's validator rejects the draft 2020-12 $schema meta-reference.
    JSON.stringify({ ...JSON.parse(await readFile(outputSchemaPath, "utf8")), $schema: undefined }),
    "--disallowedTools",
    DISALLOWED_BUILTIN_TOOLS,
    ...(input.toolNames.length > 0
      ? ["--allowedTools", input.toolNames.map((name) => `mcp__lore__${name}`).join(",")]
      : []),
  ];
  const startedAt = performance.now();
  const subprocess = spawn("claude", args, {
    cwd: runDirectory,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => subprocess.kill("SIGTERM"), input.timeoutMs ?? 180_000);
  let stdout = "";
  let stderr = "";
  subprocess.stdout.setEncoding("utf8");
  subprocess.stderr.setEncoding("utf8");
  subprocess.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  subprocess.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  subprocess.stdin.end(input.prompt);

  try {
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      subprocess.once("error", rejectExit);
      subprocess.once("close", resolveExit);
    });
    if (exitCode !== 0) {
      throw new Error(
        `Claude retrieval-policy turn failed (${exitCode}): ${stderr.trim().slice(-4_000) || stdout.trim().slice(-4_000) || "no output"}`,
      );
    }
    return parseClaudeRetrievalPolicyArtifacts({
      resultEnvelopeJson: stdout,
      toolTraceJsonLines: await readLinesWhenPresent(tracePath),
      latencyMs: performance.now() - startedAt,
    });
  } finally {
    clearTimeout(timeout);
    await rm(runDirectory, { recursive: true, force: true });
  }
}

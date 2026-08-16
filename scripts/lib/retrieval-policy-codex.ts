import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetrievalPolicyToolCall, RetrievalPolicyTrace } from "./retrieval-policy-benchmark";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../../packages/mcp/benchmark-fixture.ts", import.meta.url),
);
const outputSchemaPath = fileURLToPath(
  new URL("../fixtures/retrieval-policy-output.schema.json", import.meta.url),
);

interface CodexFinalOutput {
  outcome: "answered" | "clarified" | "abstained";
  answer: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseFinalOutput(value: string): CodexFinalOutput {
  const parsed = record(JSON.parse(value));
  const outcome = parsed?.outcome;
  const answer = parsed?.answer;
  if (
    (outcome !== "answered" && outcome !== "clarified" && outcome !== "abstained") ||
    typeof answer !== "string"
  ) {
    throw new Error("Codex retrieval-policy output does not match its fixed schema");
  }
  return { outcome, answer };
}

function parseToolTrace(lines: readonly string[]): RetrievalPolicyToolCall[] {
  return lines.filter(Boolean).map((line) => {
    const parsed = record(JSON.parse(line));
    if (!parsed || typeof parsed.name !== "string") {
      throw new Error("Codex retrieval-policy MCP trace is malformed");
    }
    return {
      name: parsed.name,
      arguments: record(parsed.arguments) ?? {},
      result: parsed.result,
    };
  });
}

function parseUsage(lines: readonly string[]): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = record(JSON.parse(lines[index] ?? "{}"));
    if (event?.type !== "turn.completed") continue;
    const usage = record(event.usage);
    return {
      inputTokens: nonnegativeNumber(usage?.input_tokens),
      outputTokens: nonnegativeNumber(usage?.output_tokens),
    };
  }
  return { inputTokens: null, outputTokens: null };
}

export function parseCodexRetrievalPolicyArtifacts(input: {
  eventJsonLines: readonly string[];
  toolTraceJsonLines: readonly string[];
  finalOutput: string;
  latencyMs: number;
}): RetrievalPolicyTrace & { answer: string } {
  const finalOutput = parseFinalOutput(input.finalOutput);
  const usage = parseUsage(input.eventJsonLines);
  return {
    assistantOutcome: finalOutput.outcome,
    answer: finalOutput.answer,
    latencyMs: input.latencyMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    toolCalls: parseToolTrace(input.toolTraceJsonLines),
  };
}

async function symlinkWhenPresent(source: string, target: string): Promise<void> {
  try {
    await access(source);
    await symlink(source, target);
  } catch (error) {
    const code = record(error)?.code;
    if (code !== "ENOENT") throw error;
  }
}

export function codexRetrievalPolicyToolFilter(toolNames: readonly string[]): string {
  return toolNames.length === 0 ? "__none__" : toolNames.join(",");
}

function mcpEnvironment(toolNames: readonly string[], tracePath: string): string {
  return `{LORE_RETRIEVAL_POLICY_TOOLS=${JSON.stringify(codexRetrievalPolicyToolFilter(toolNames))},LORE_RETRIEVAL_POLICY_TRACE_PATH=${JSON.stringify(tracePath)}}`;
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

export interface CodexRetrievalPolicyTurnInput {
  model: string;
  prompt: string;
  toolNames: readonly string[];
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
}

export async function runCodexRetrievalPolicyTurn(
  input: CodexRetrievalPolicyTurnInput,
): Promise<RetrievalPolicyTrace & { answer: string }> {
  const runDirectory = await mkdtemp(join(tmpdir(), "lore-retrieval-policy-run."));
  const isolatedCodexState = await mkdtemp(join(tmpdir(), "lore-retrieval-policy-codex."));
  const configuredCodexState = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const tracePath = join(runDirectory, "mcp-trace.jsonl");
  const outputPath = join(runDirectory, "final.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([
    symlinkWhenPresent(
      join(configuredCodexState, "auth.json"),
      join(isolatedCodexState, "auth.json"),
    ),
    symlinkWhenPresent(
      join(configuredCodexState, "models_cache.json"),
      join(isolatedCodexState, "models_cache.json"),
    ),
  ]);

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "-C",
    runDirectory,
    "-m",
    input.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(input.reasoningEffort ?? "low")}`,
    "--disable",
    "plugins",
    "--disable",
    "skill_search",
    "--disable",
    "apps",
    "--disable",
    "tool_suggest",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "browser_use_full_cdp_access",
    "--disable",
    "in_app_browser",
    "--disable",
    "hooks",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "computer_use",
    "--disable",
    "image_generation",
    "--disable",
    "workspace_dependencies",
    "-c",
    'mcp_servers.lore.command="bun"',
    "-c",
    `mcp_servers.lore.args=${JSON.stringify([fixturePath])}`,
    "-c",
    `mcp_servers.lore.env=${mcpEnvironment(input.toolNames, tracePath)}`,
    "--output-schema",
    outputSchemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ];
  const startedAt = performance.now();
  const subprocess = spawn("codex", args, {
    cwd: repositoryRoot,
    env: { ...process.env, CODEX_HOME: isolatedCodexState },
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
        `Codex retrieval-policy turn failed (${exitCode}): ${stderr.trim().slice(-4_000) || stdout.trim().slice(-4_000) || "no output"}`,
      );
    }
    return parseCodexRetrievalPolicyArtifacts({
      eventJsonLines: jsonLines(stdout),
      toolTraceJsonLines: await readLinesWhenPresent(tracePath),
      finalOutput: await readFile(outputPath, "utf8"),
      latencyMs: performance.now() - startedAt,
    });
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled([
      rm(runDirectory, { recursive: true, force: true }),
      rm(isolatedCodexState, { recursive: true, force: true }),
    ]);
  }
}

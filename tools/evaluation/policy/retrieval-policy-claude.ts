import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetrievalPolicyTrace } from "./retrieval-policy";
import { codexRetrievalPolicyToolFilter } from "./retrieval-policy-codex";

const fixturePath = fileURLToPath(
  new URL("../../../packages/mcp/benchmark-fixture.ts", import.meta.url),
);
const outputSchemaPath = fileURLToPath(
  new URL("./retrieval-policy-output.schema.json", import.meta.url),
);

// The CLI inherits only what it needs to start, reach the API, and authenticate
// (API key, OAuth token or credential store, or a Bedrock/Vertex/Foundry
// provider). Lore's own settings, database URLs, and provider keys never reach it
// or the fixture MCP server it spawns.
const CLAUDE_ENVIRONMENT_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
]);
const CLAUDE_ENVIRONMENT_PREFIXES = ["ANTHROPIC_", "AWS_"];

export function isClaudeRetrievalPolicyEnvironmentName(name: string): boolean {
  return (
    CLAUDE_ENVIRONMENT_NAMES.has(name) ||
    CLAUDE_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The minimal environment for one isolated Claude Code benchmark turn. */
export function claudeRetrievalPolicyEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (!isClaudeRetrievalPolicyEnvironmentName(name)) delete environment[name];
  }
  return environment;
}

/**
 * Isolated Claude Code arguments, modeled on the Codex runner's isolation: no
 * user/project/local settings (hooks, permissions, plugins, env, CLAUDE.md),
 * no skills, no saved session, no built-in tools, only the fixture MCP server,
 * and an explicit allowlist of its Lore tools; anything else is denied.
 */
export function claudeRetrievalPolicyArguments(input: {
  model: string;
  toolNames: readonly string[];
  mcpConfig: unknown;
  outputSchema: unknown;
}): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(input.mcpConfig),
    "--json-schema",
    JSON.stringify(input.outputSchema),
    ...(input.toolNames.length > 0
      ? ["--allowedTools", input.toolNames.map((name) => `mcp__lore__${name}`).join(",")]
      : []),
  ];
}

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
  // Claude's envelope splits prompt tokens across direct input and cache creation/read.
  const inputParts = [
    nonnegativeNumber(usage?.input_tokens),
    nonnegativeNumber(usage?.cache_creation_input_tokens),
    nonnegativeNumber(usage?.cache_read_input_tokens),
  ].filter((value): value is number => value !== null);
  return {
    assistantOutcome: finalOutput.outcome,
    answer: finalOutput.answer,
    latencyMs: input.latencyMs,
    inputTokens: inputParts.length === 0 ? null : inputParts.reduce((sum, value) => sum + value, 0),
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
  const args = claudeRetrievalPolicyArguments({
    model: input.model,
    toolNames: input.toolNames,
    mcpConfig,
    // Claude CLI's validator rejects the draft 2020-12 $schema meta-reference.
    outputSchema: { ...JSON.parse(await readFile(outputSchemaPath, "utf8")), $schema: undefined },
  });
  const startedAt = performance.now();
  const subprocess = spawn("claude", args, {
    cwd: runDirectory,
    env: claudeRetrievalPolicyEnvironment(process.env),
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

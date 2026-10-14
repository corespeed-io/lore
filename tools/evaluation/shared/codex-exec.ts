import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Features a tool-less judging turn must never reach. */
const DISABLED_FEATURES = [
  "plugins",
  "skill_search",
  "apps",
  "tool_suggest",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "hooks",
  "shell_tool",
  "unified_exec",
  "computer_use",
  "image_generation",
  "workspace_dependencies",
] as const;

export interface CodexTextResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Token usage from the last `turn.completed` event of `codex exec --json`. */
export function codexTurnUsage(eventLines: readonly string[]): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  for (let index = eventLines.length - 1; index >= 0; index -= 1) {
    const line = eventLines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    const event = JSON.parse(line) as { type?: unknown; usage?: Record<string, unknown> };
    if (event.type !== "turn.completed") continue;
    return {
      inputTokens: nonnegative(event.usage?.input_tokens),
      outputTokens: nonnegative(event.usage?.output_tokens),
    };
  }
  return { inputTokens: null, outputTokens: null };
}

async function linkWhenPresent(source: string, target: string): Promise<void> {
  try {
    await access(source);
    await symlink(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * One isolated, tool-less `codex exec` turn that returns its final message. As in
 * the retrieval-policy runner, a throwaway CODEX_HOME holds only the existing login
 * and model cache, so no user config, rules, memories, or sessions take part.
 */
export async function runCodexText(input: {
  model: string;
  prompt: string;
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
}): Promise<CodexTextResult> {
  const runDirectory = await mkdtemp(join(tmpdir(), "lore-codex-text-run."));
  const isolatedState = await mkdtemp(join(tmpdir(), "lore-codex-text-home."));
  const configuredState = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const outputPath = join(runDirectory, "final.txt");
  await Promise.all([
    linkWhenPresent(join(configuredState, "auth.json"), join(isolatedState, "auth.json")),
    linkWhenPresent(
      join(configuredState, "models_cache.json"),
      join(isolatedState, "models_cache.json"),
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
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--output-last-message",
    outputPath,
    "-",
  ];
  const startedAt = performance.now();
  const subprocess = spawn("codex", args, {
    cwd: runDirectory,
    env: { ...process.env, CODEX_HOME: isolatedState },
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
      // Codex always warns that it cannot create PATH helpers under a temporary home.
      const reason = stderr
        .split("\n")
        .filter((line) => line.trim() && !line.includes("could not create PATH aliases"))
        .join("\n")
        .trim();
      throw new Error(
        `Codex turn failed (${exitCode}): ${reason.slice(-2_000) || stdout.trim().slice(-2_000) || "no output"}`,
      );
    }
    return {
      text: await readFile(outputPath, "utf8"),
      ...codexTurnUsage(stdout.split("\n")),
      latencyMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled([
      rm(runDirectory, { recursive: true, force: true }),
      rm(isolatedState, { recursive: true, force: true }),
    ]);
  }
}

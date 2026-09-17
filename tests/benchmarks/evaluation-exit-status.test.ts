import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const foundation = "tools/evaluation/code/evaluate-code-aware-memory.ts";
const joint = "tools/evaluation/context/evaluate-joint-memory-code.ts";

function runEvaluation(entrypoint: string, args: string[] = [], initialExitCode?: number) {
  const command =
    initialExitCode === undefined
      ? [entrypoint, "--strict", ...args]
      : [
          "--eval",
          `process.exitCode = ${initialExitCode};
           process.argv = [process.execPath, ${JSON.stringify(entrypoint)}, "--strict", ...${JSON.stringify(args)}];
           await import(${JSON.stringify(`./${entrypoint}`)});`,
        ];
  const result = spawnSync("bun", command, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  return result;
}

test.each([foundation, joint])("a passing %s exits successfully", (entrypoint) => {
  const result = runEvaluation(entrypoint);
  expect(JSON.parse(result.stdout).decision).toBe("pass");
  expect(result.status, result.stderr).toBe(0);
});

test("evaluation startup and database cleanup preserve an existing failure status", () => {
  const result = runEvaluation(foundation, [], 7);
  expect(JSON.parse(result.stdout).decision).toBe("pass");
  expect(result.status, result.stderr).toBe(7);
});

test("an output error after a passing evaluation still exits with failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lore-evaluation-exit-"));
  const blockedDirectory = join(directory, "file");
  try {
    await writeFile(blockedDirectory, "not a directory");
    const result = runEvaluation(foundation, ["--output", join(blockedDirectory, "report.json")]);
    expect(JSON.parse(result.stdout).decision).toBe("pass");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/EEXIST|ENOTDIR/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

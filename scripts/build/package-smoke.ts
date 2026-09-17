import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

const repository = new URL("../../", import.meta.url);
assert.ok(process.versions.bun, "Run this smoke test with Bun");

function run(
  command: string,
  args: string[],
  options: { cwd?: string | URL; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function packedTarball(packageDirectory: string, destination: string) {
  const archive = join(destination, `${basename(packageDirectory)}.tgz`);
  run(process.execPath, ["--no-env-file", "pm", "pack", "--filename", archive], {
    cwd: new URL(`${packageDirectory}/`, repository),
  });
  return archive;
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "lore-package-smoke-"));
try {
  const consumer = join(temporaryDirectory, "consumer");
  await mkdir(consumer);
  const sdkTarball = packedTarball("./packages/typescript-sdk", temporaryDirectory);
  const cliTarball = packedTarball("./packages/cli", temporaryDirectory);
  const mcpTarball = packedTarball("./packages/mcp", temporaryDirectory);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "lore-package-smoke",
      private: true,
      type: "module",
      overrides: { "@corespeed/lore-sdk": sdkTarball },
    }),
  );
  const executablePath = [
    join(consumer, "node_modules/.bin"),
    dirname(process.execPath),
    process.env.PATH ?? "",
  ].join(delimiter);
  const consumerEnvironment = { PATH: executablePath };
  run(
    process.execPath,
    ["--no-env-file", "add", "--ignore-scripts", sdkTarball, cliTarball, mcpTarball],
    { cwd: consumer, env: consumerEnvironment },
  );
  // Executables accept only explicit credentials, even inside a project with .env.
  await writeFile(join(consumer, ".env"), "LORE_WORKSPACE_ID=must-not-be-loaded\n");

  const librarySmoke = run(
    process.execPath,
    [
      "--no-env-file",
      "--eval",
      [
        'const sdk = await import("@corespeed/lore-sdk");',
        'const cli = await import("@corespeed/lore-cli");',
        'const mcp = await import("@corespeed/lore-mcp");',
        'if (typeof sdk.LoreClient !== "function") throw new Error("SDK export missing");',
        'if (typeof cli.runLoreCli !== "function") throw new Error("CLI export missing");',
        'if (typeof mcp.createLoreMcpServer !== "function") throw new Error("MCP export missing");',
        'console.log("ok");',
      ].join("\n"),
    ],
    { cwd: consumer, env: consumerEnvironment },
  );
  if (librarySmoke !== "ok") throw new Error("Packed package exports failed");

  const cliManifest: unknown = JSON.parse(
    await readFile(new URL("packages/cli/package.json", repository), "utf8"),
  );
  assert.ok(
    cliManifest !== null &&
      typeof cliManifest === "object" &&
      "version" in cliManifest &&
      typeof cliManifest.version === "string",
    "CLI package manifest must declare a version",
  );
  const cliVersion = run("lore", ["--version"], {
    cwd: consumer,
    env: consumerEnvironment,
  });
  if (cliVersion !== cliManifest.version) {
    throw new Error(`Packed CLI version ${cliVersion} does not match ${cliManifest.version}`);
  }

  const mcpResult = spawnSync("lore-mcp", [], {
    cwd: consumer,
    encoding: "utf8",
    env: consumerEnvironment,
  });
  if (mcpResult.status !== 1 || !mcpResult.stderr.includes("LORE_WORKSPACE_ID is required")) {
    throw new Error("Packed MCP executable did not start and validate configuration safely");
  }

  console.log("Lore package smoke passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

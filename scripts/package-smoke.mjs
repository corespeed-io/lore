import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { supportedPythonInterpreter } from "./python-interpreter.mjs";

const repository = new URL("../", import.meta.url);

function run(command, args, options = {}) {
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

function packedTarball(packageDirectory, destination) {
  const output = run("npm", [
    "pack",
    packageDirectory,
    "--pack-destination",
    destination,
    "--json",
  ]);
  const result = JSON.parse(output);
  const candidates = Array.isArray(result)
    ? result
    : result && typeof result === "object" && typeof result.filename === "string"
      ? [result]
      : result && typeof result === "object"
        ? Object.values(result)
        : [];
  const packed = candidates.find(
    (candidate) =>
      candidate && typeof candidate === "object" && typeof candidate.filename === "string",
  );
  if (!packed) {
    throw new Error(`npm pack returned an invalid result for ${packageDirectory}`);
  }
  return join(destination, packed.filename);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "lore-package-smoke-"));
try {
  const consumer = join(temporaryDirectory, "consumer");
  const pythonPackage = join(temporaryDirectory, "python-sdk");
  const pythonTarget = join(temporaryDirectory, "python-target");
  await mkdir(consumer);
  await mkdir(pythonTarget);
  await cp(new URL("packages/python-sdk", repository), pythonPackage, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "lore-package-smoke", private: true, type: "module" }),
  );

  const sdkTarball = packedTarball("./packages/typescript-sdk", temporaryDirectory);
  const cliTarball = packedTarball("./packages/cli", temporaryDirectory);
  const mcpTarball = packedTarball("./packages/mcp", temporaryDirectory);
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumer,
      sdkTarball,
      cliTarball,
      mcpTarball,
    ],
    { cwd: consumer },
  );

  const librarySmoke = run(
    process.execPath,
    [
      "--input-type=module",
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
    { cwd: consumer },
  );
  if (librarySmoke !== "ok") throw new Error("Packed package exports failed");

  const cliManifest = JSON.parse(
    await readFile(new URL("packages/cli/package.json", repository), "utf8"),
  );
  const executablePath = `${join(consumer, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`;
  const cliVersion = run("lore", ["--version"], {
    cwd: consumer,
    env: { ...process.env, PATH: executablePath },
  });
  if (cliVersion !== cliManifest.version) {
    throw new Error(`Packed CLI version ${cliVersion} does not match ${cliManifest.version}`);
  }

  const mcpResult = spawnSync("lore-mcp", [], {
    cwd: consumer,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: executablePath,
      LORE_WORKSPACE_ID: "",
    },
  });
  if (mcpResult.status !== 1 || !mcpResult.stderr.includes("LORE_WORKSPACE_ID is required")) {
    throw new Error("Packed MCP executable did not start and validate configuration safely");
  }

  const python = supportedPythonInterpreter();
  if (!python) {
    throw new Error(
      "Lore Python package smoke requires Python 3.12 or newer. Set LORE_PYTHON to a supported interpreter.",
    );
  }
  run(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-deps",
    "--target",
    pythonTarget,
    pythonPackage,
  ]);
  run(python, ["-c", "from corespeed_lore import LoreClient; print(LoreClient.__name__)"], {
    env: { ...process.env, PYTHONPATH: pythonTarget },
  });
  console.log("Lore package smoke passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { verifyFile } from "./lib/file-integrity";
import { memoryAgentBenchManifest } from "./lib/memoryagentbench";

const target = process.argv[2] ?? "conflict";
if (target !== "accurate" && target !== "conflict") {
  throw new Error("MemoryAgentBench fetch target must be accurate or conflict");
}
const file = memoryAgentBenchManifest.files[target];
const dataDirectory = resolve(
  process.env.LORE_MEMORYAGENTBENCH_DATA_DIR ?? "evaluation/datasets/memoryagentbench",
);
const outputPath = resolve(dataDirectory, file.path);
const temporaryPath = `${outputPath}.${process.pid}.partial`;
await mkdir(dirname(outputPath), { recursive: true });
try {
  await access(outputPath, constants.F_OK);
  await verifyFile(outputPath, file);
  console.log(`MemoryAgentBench ${file.path} is already verified`);
  process.exit(0);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const url = new URL("https://datasets-server.huggingface.co/rows");
for (const [key, value] of Object.entries({
  dataset: "ai-hyz/MemoryAgentBench",
  config: "default",
  split: file.split,
  offset: "0",
  length: String(file.rows),
  revision: memoryAgentBenchManifest.revision,
})) {
  url.searchParams.set(key, value);
}
console.error(`Fetching pinned MemoryAgentBench ${file.split} rows...`);
const response = await fetch(url);
if (!response.ok) throw new Error(`MemoryAgentBench fetch failed with HTTP ${response.status}`);
const payload = (await response.json()) as { rows?: unknown };
if (!Array.isArray(payload.rows) || payload.rows.length !== file.rows) {
  throw new Error("MemoryAgentBench dataset server returned the wrong row count");
}
const rows = payload.rows.map((entry) => {
  if (typeof entry !== "object" || entry === null || !("row" in entry)) {
    throw new Error("MemoryAgentBench dataset server returned an invalid row");
  }
  return (entry as { row: unknown }).row;
});
const serialized = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const bytes = new TextEncoder().encode(serialized).byteLength;
const sha256 = createHash("sha256").update(serialized).digest("hex");
if (bytes !== file.bytes || sha256 !== file.sha256) {
  throw new Error(`MemoryAgentBench verification failed: ${bytes} bytes / ${sha256}`);
}
try {
  await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, outputPath);
  console.log(`Verified MemoryAgentBench ${file.path}`);
} catch (error) {
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyFile } from "./lib/file-integrity";
import { type LongMemEvalSplit, longMemEvalManifest } from "./lib/longmemeval";

function splitFrom(value: string | undefined): LongMemEvalSplit {
  if (value === "oracle" || value === "s" || value === "m") return value;
  throw new Error("LongMemEval split must be oracle, s, or m");
}

const split = splitFrom(process.argv[2] ?? "s");
const file = longMemEvalManifest.files[split];
const dataDirectory = resolve(
  process.env.LORE_LONGMEMEVAL_DATA_DIR ?? "evaluation/datasets/longmemeval",
);
const outputPath = resolve(dataDirectory, file.filename);
const temporaryPath = `${outputPath}.${process.pid}.partial`;

await mkdir(dataDirectory, { recursive: true });
try {
  await access(outputPath, constants.F_OK);
  await verifyFile(outputPath, file);
  console.log(`LongMemEval ${split} is already verified at ${outputPath}`);
  process.exit(0);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const sourceUrl = `${longMemEvalManifest.source}/resolve/${longMemEvalManifest.revision}/${file.filename}`;
console.error(`Downloading LongMemEval ${split} (${file.bytes.toLocaleString()} bytes)...`);
const response = await fetch(sourceUrl);
if (!response.ok || !response.body) {
  throw new Error(`LongMemEval download failed with HTTP ${response.status}`);
}

const output = await open(temporaryPath, "wx");
const hash = createHash("sha256");
let downloadedBytes = 0;
try {
  for await (const chunk of response.body) {
    hash.update(chunk);
    downloadedBytes += chunk.byteLength;
    await output.write(chunk);
  }
  await output.close();
  const digest = hash.digest("hex");
  if (downloadedBytes !== file.bytes || digest !== file.sha256) {
    throw new Error(
      `Downloaded LongMemEval ${split} failed integrity verification: ${downloadedBytes} bytes / ${digest}`,
    );
  }
  await rename(temporaryPath, outputPath);
  console.log(`Verified LongMemEval ${split} at ${outputPath}`);
} catch (error) {
  await output.close().catch(() => undefined);
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

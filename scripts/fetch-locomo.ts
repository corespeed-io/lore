import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyFile } from "./lib/file-integrity";
import { locomoManifest } from "./lib/locomo";

const file = locomoManifest.files.dataset;
const dataDirectory = resolve(process.env.LORE_LOCOMO_DATA_DIR ?? "evaluation/datasets/locomo");
const outputPath = resolve(dataDirectory, file.filename);
const temporaryPath = `${outputPath}.${process.pid}.partial`;

await mkdir(dataDirectory, { recursive: true });
try {
  await access(outputPath, constants.F_OK);
  await verifyFile(outputPath, file);
  console.log(`LoCoMo is already verified at ${outputPath}`);
  process.exit(0);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const sourceUrl = `https://raw.githubusercontent.com/snap-research/locomo/${locomoManifest.revision}/${file.path}`;
console.error(`Downloading LoCoMo (${file.bytes.toLocaleString()} bytes, CC BY-NC 4.0)...`);
const response = await fetch(sourceUrl);
if (!response.ok || !response.body) {
  throw new Error(`LoCoMo download failed with HTTP ${response.status}`);
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
      `Downloaded LoCoMo failed integrity verification: ${downloadedBytes} bytes / ${digest}`,
    );
  }
  await rename(temporaryPath, outputPath);
  console.log(`Verified LoCoMo at ${outputPath}`);
} catch (error) {
  await output.close().catch(() => undefined);
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

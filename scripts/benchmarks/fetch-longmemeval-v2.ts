import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { verifyFile } from "./lib/file-integrity";
import { longMemEvalV2Manifest } from "./lib/longmemeval-v2";

type DatasetTier = "metadata" | "small" | "medium";
type FileKey = keyof typeof longMemEvalV2Manifest.files;
interface DatasetFile {
  path: string;
  bytes: number;
  sha256: string;
}

function tierFrom(value: string | undefined): DatasetTier {
  if (value === undefined || value === "metadata") return "metadata";
  if (value === "small" || value === "medium") return value;
  throw new Error("LongMemEval-V2 fetch tier must be metadata, small, or medium");
}

async function fetchFile(file: DatasetFile, dataDirectory: string): Promise<void> {
  const outputPath = resolve(dataDirectory, file.path);
  const temporaryPath = `${outputPath}.${process.pid}.partial`;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await access(outputPath, constants.F_OK);
    await verifyFile(outputPath, file);
    console.log(`LongMemEval-V2 ${file.path} is already verified`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const sourceUrl = `${longMemEvalV2Manifest.source}/resolve/${longMemEvalV2Manifest.revision}/${file.path}`;
  console.error(`Downloading ${file.path} (${file.bytes.toLocaleString()} bytes)...`);
  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`LongMemEval-V2 download failed with HTTP ${response.status}`);
  }
  const output = await open(temporaryPath, "wx");
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      hash.update(chunk);
      downloadedBytes += chunk.byteLength;
      await output.write(chunk);
    }
    await output.close();
    const digest = hash.digest("hex");
    if (downloadedBytes !== file.bytes || digest !== file.sha256) {
      throw new Error(
        `LongMemEval-V2 ${file.path} failed verification: ${downloadedBytes} bytes / ${digest}`,
      );
    }
    await rename(temporaryPath, outputPath);
    console.log(`Verified LongMemEval-V2 ${file.path}`);
  } catch (error) {
    await output.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

const tier = tierFrom(process.argv[2]);
const dataDirectory = resolve(
  process.env.LORE_LONGMEMEVAL_V2_DATA_DIR ?? "evaluation/datasets/longmemeval-v2",
);
const files: FileKey[] = ["questions", tier === "medium" ? "medium" : "small"];
if (tier !== "metadata") files.push("trajectories");
for (const key of files) await fetchFile(longMemEvalV2Manifest.files[key], dataDirectory);
for (const screenshot of longMemEvalV2Manifest.questionScreenshots) {
  await fetchFile(screenshot, dataDirectory);
}
if (tier === "metadata") {
  console.log(
    "Metadata and question screenshots ready. Fetch the small or medium tier explicitly to download trajectories.",
  );
}

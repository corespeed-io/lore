import { resolve } from "node:path";
import { datasetIsVerified, downloadDataset } from "./lib/dataset-download";
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
  if (await datasetIsVerified(outputPath, file)) {
    console.log(`LongMemEval-V2 ${file.path} is already verified`);
    return;
  }
  const sourceUrl = `${longMemEvalV2Manifest.source}/resolve/${longMemEvalV2Manifest.revision}/${file.path}`;
  console.error(`Downloading ${file.path} (${file.bytes.toLocaleString()} bytes)...`);
  await downloadDataset({
    url: sourceUrl,
    outputPath,
    expected: file,
    label: `LongMemEval-V2 ${file.path}`,
  });
  console.log(`Verified LongMemEval-V2 ${file.path}`);
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

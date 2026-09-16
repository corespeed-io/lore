import { resolve } from "node:path";
import { datasetIsVerified, downloadDataset } from "./lib/dataset-download";
import type { LongMemEvalSplit } from "./lib/longmemeval";
import { longMemEvalManifest } from "./lib/longmemeval";

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

if (await datasetIsVerified(outputPath, file)) {
  console.log(`LongMemEval ${split} is already verified at ${outputPath}`);
} else {
  const sourceUrl = `${longMemEvalManifest.source}/resolve/${longMemEvalManifest.revision}/${file.filename}`;
  console.error(`Downloading LongMemEval ${split} (${file.bytes.toLocaleString()} bytes)...`);
  await downloadDataset({
    url: sourceUrl,
    outputPath,
    expected: file,
    label: `LongMemEval ${split}`,
  });
  console.log(`Verified LongMemEval ${split} at ${outputPath}`);
}

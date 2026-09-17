import { resolve } from "node:path";
import { datasetIsVerified, downloadDataset } from "../shared/dataset-download";
import { locomoManifest } from "./locomo";

const file = locomoManifest.files.dataset;
const dataDirectory = resolve(process.env.LORE_LOCOMO_DATA_DIR ?? "evaluation/datasets/locomo");
const outputPath = resolve(dataDirectory, file.filename);

if (await datasetIsVerified(outputPath, file)) {
  console.log(`LoCoMo is already verified at ${outputPath}`);
} else {
  const sourceUrl = `https://raw.githubusercontent.com/snap-research/locomo/${locomoManifest.revision}/${file.path}`;
  console.error(`Downloading LoCoMo (${file.bytes.toLocaleString()} bytes), CC BY-NC 4.0...`);
  await downloadDataset({ url: sourceUrl, outputPath, expected: file, label: `LoCoMo` });
  console.log(`Verified LoCoMo at ${outputPath}`);
}

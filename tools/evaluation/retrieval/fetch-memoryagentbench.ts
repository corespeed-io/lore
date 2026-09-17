import { resolve } from "node:path";
import { downloadMemoryAgentBench } from "./memoryagentbench-download";

const target = process.argv[2] ?? "conflict";
if (target !== "accurate" && target !== "conflict") {
  throw new Error("MemoryAgentBench fetch target must be accurate or conflict");
}
await downloadMemoryAgentBench(
  target,
  resolve(process.env.LORE_MEMORYAGENTBENCH_DATA_DIR ?? "evaluation/datasets/memoryagentbench"),
);

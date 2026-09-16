import { spawnSync } from "node:child_process";

export function supportedPythonInterpreter() {
  const candidates = [
    process.env.LORE_PYTHON,
    "python3.14",
    "python3.13",
    "python3.12",
    "python3",
    "python",
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

  return candidates.find((candidate) => {
    const checked = spawnSync(
      candidate,
      ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"],
      { stdio: "ignore" },
    );
    return checked.status === 0;
  });
}

import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { supportedPythonInterpreter } from "./python-interpreter.mjs";

const interpreter = supportedPythonInterpreter();

if (!interpreter) {
  console.error(
    "Lore Python SDK tests require Python 3.12 or newer. Set LORE_PYTHON to a supported interpreter.",
  );
  process.exitCode = 1;
} else {
  const sourcePath = resolve("packages/python-sdk/src");
  const pythonPath = process.env.PYTHONPATH
    ? `${sourcePath}${delimiter}${process.env.PYTHONPATH}`
    : sourcePath;
  const result = spawnSync(
    interpreter,
    ["-m", "unittest", "discover", "-s", "packages/python-sdk/tests"],
    {
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: pythonPath,
      },
      stdio: "inherit",
    },
  );
  process.exitCode = result.status ?? 1;
}

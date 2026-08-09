import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function* readJsonLines(filePath: string): AsyncGenerator<unknown> {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON on line ${lineNumber} of ${filePath}: ${error instanceof Error ? error.message : "parse error"}`,
      );
    }
  }
}

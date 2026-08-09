import { createReadStream } from "node:fs";

const whitespace = /\s/;

/**
 * Streams a top-level JSON array without retaining the complete dataset in
 * memory. LongMemEval-M is several gigabytes, while an individual record is
 * small enough to validate and ingest independently.
 */
export async function* readJsonArray(
  filePath: string,
  options: { highWaterMark?: number } = {},
): AsyncGenerator<unknown> {
  const input = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: options.highWaterMark,
  });
  let buffer = "";
  let cursor = 0;
  let arrayStarted = false;
  let arrayEnded = false;
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectingValue = true;
  let hasValue = false;

  for await (const chunk of input) {
    buffer += chunk;

    while (cursor < buffer.length) {
      const character = buffer[cursor];
      if (!arrayStarted) {
        if (whitespace.test(character)) {
          cursor += 1;
          continue;
        }
        if (character !== "[") throw new Error("Expected a top-level JSON array");
        arrayStarted = true;
        cursor += 1;
        continue;
      }

      if (objectStart < 0) {
        if (whitespace.test(character)) {
          cursor += 1;
          continue;
        }
        if (arrayEnded) throw new Error("Unexpected data after the JSON array");
        if (character === "]") {
          if (expectingValue && hasValue) throw new Error("Trailing comma in top-level JSON array");
          arrayEnded = true;
          cursor += 1;
          continue;
        }
        if (character === ",") {
          if (expectingValue) throw new Error("Unexpected comma in top-level JSON array");
          expectingValue = true;
          cursor += 1;
          continue;
        }
        if (!expectingValue) throw new Error("Expected a comma between JSON records");
        if (character !== "{") throw new Error("Expected a JSON object in the top-level array");
        objectStart = cursor;
        depth = 1;
        cursor += 1;
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
      } else if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const record = buffer.slice(objectStart, cursor + 1);
          cursor += 1;
          buffer = buffer.slice(cursor);
          cursor = 0;
          objectStart = -1;
          expectingValue = false;
          hasValue = true;
          yield JSON.parse(record) as unknown;
          continue;
        }
      }
      cursor += 1;
    }

    if (objectStart < 0 && cursor > 0) {
      buffer = buffer.slice(cursor);
      cursor = 0;
    }
  }

  if (!arrayStarted) throw new Error("Expected a top-level JSON array");
  if (objectStart >= 0 || inString || depth !== 0) throw new Error("Unexpected end of JSON record");
  if (!arrayEnded) throw new Error("Unexpected end of top-level JSON array");
  if (buffer.trim()) throw new Error("Unexpected data after the JSON array");
}

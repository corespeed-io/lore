import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface FileIntegrity {
  bytes: number;
  sha256: string;
}

export async function inspectFile(filePath: string): Promise<FileIntegrity> {
  const file = await stat(filePath);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { bytes: file.size, sha256: hash.digest("hex") };
}

export async function verifyFile(filePath: string, expected: FileIntegrity): Promise<void> {
  const actual = await inspectFile(filePath);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(
      `Dataset integrity mismatch for ${filePath}: expected ${expected.bytes} bytes / ${expected.sha256}, got ${actual.bytes} bytes / ${actual.sha256}`,
    );
  }
}

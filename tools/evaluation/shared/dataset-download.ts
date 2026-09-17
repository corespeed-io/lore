import { createHash } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { type FileIntegrity, verifyFile } from "./file-integrity";

export async function datasetIsVerified(path: string, expected: FileIntegrity): Promise<boolean> {
  try {
    await verifyFile(path, expected);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Stream large pinned datasets; only promote a complete, verified temporary file.
export async function downloadDataset(input: {
  url: string | URL;
  outputPath: string;
  expected: FileIntegrity;
  label: string;
}): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  const response = await fetch(input.url);
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${input.label} download failed with HTTP ${response.status}`);
  }
  const temporaryPath = `${input.outputPath}.${process.pid}.partial`;
  let output: FileHandle;
  try {
    output = await open(temporaryPath, "wx");
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      downloadedBytes += chunk.byteLength;
      if (downloadedBytes > input.expected.bytes) {
        throw new Error(`${input.label} download exceeds ${input.expected.bytes} bytes`);
      }
      // FileHandle.write may perform a partial write.
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.byteLength - offset);
        if (!bytesWritten) throw new Error(`${input.label} download write made no progress`);
        offset += bytesWritten;
      }
    }
    await output.close();
    const digest = hash.digest("hex");
    if (downloadedBytes !== input.expected.bytes || digest !== input.expected.sha256) {
      throw new Error(
        `${input.label} failed integrity verification: ${downloadedBytes} bytes / ${digest}`,
      );
    }
    await rename(temporaryPath, input.outputPath);
  } catch (error) {
    await output.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

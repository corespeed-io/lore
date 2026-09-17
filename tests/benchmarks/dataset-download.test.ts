import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { datasetIsVerified, downloadDataset } from "../../tools/evaluation/shared/dataset-download";

const directories: string[] = [];
const body = new TextEncoder().encode("A pinned 数据集\n");
const expected = {
  bytes: body.byteLength,
  sha256: createHash("sha256").update(body).digest("hex"),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lore-download-"));
  directories.push(directory);
  return { directory, outputPath: join(directory, "dataset.json") };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("a verified streamed download is promoted and can be reused", async () => {
  const { directory, outputPath } = await fixture();
  expect(await datasetIsVerified(outputPath, expected)).toBe(false);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  await downloadDataset({ url: "https://dataset.test", outputPath, expected, label: "fixture" });
  expect(await datasetIsVerified(outputPath, expected)).toBe(true);
  expect(await readFile(outputPath)).toEqual(Buffer.from(body));
  expect(await readdir(directory)).toEqual(["dataset.json"]);
});

test.each(["checksum", "oversized", "truncated"])(
  "%s downloads remove their temporary file and preserve the destination",
  async (failure) => {
    const { directory, outputPath } = await fixture();
    await writeFile(outputPath, "previous contents");
    const downloaded =
      failure === "oversized"
        ? new Uint8Array(body.byteLength + 1)
        : failure === "truncated"
          ? body.slice(0, 2)
          : new Uint8Array(body.byteLength);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(downloaded)));
    await expect(
      downloadDataset({ url: "https://dataset.test", outputPath, expected, label: "fixture" }),
    ).rejects.toThrow();
    expect(await readFile(outputPath, "utf8")).toBe("previous contents");
    expect(await readdir(directory)).toEqual(["dataset.json"]);
    await expect(datasetIsVerified(outputPath, expected)).rejects.toThrow("integrity mismatch");
  },
);

test("an existing temporary file is never deleted by a competing download", async () => {
  const { outputPath } = await fixture();
  const partialPath = `${outputPath}.${process.pid}.partial`;
  await writeFile(partialPath, "another download");
  const response = new Response(body);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(
    downloadDataset({ url: "https://dataset.test", outputPath, expected, label: "fixture" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(partialPath, "utf8")).toBe("another download");
  expect(response.bodyUsed).toBe(true);
});

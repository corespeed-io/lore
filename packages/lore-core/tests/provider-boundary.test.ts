import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const packageUrl = new URL("../", import.meta.url);

test("core does not install model SDKs as runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageUrl), "utf8"));
  const modelSdks = new Set(["@google/genai", "cohere-ai", "ollama", "openai", "voyageai"]);
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  expect(Object.keys(dependencies).filter((name) => modelSdks.has(name))).toEqual([]);
});

test("public engine entries run without OSS or installed provider SDKs", async () => {
  // A real copy outside the workspace prevents package resolution through its
  // hoisted node_modules, TypeScript path aliases, or relative OSS imports.
  const consumerDirectory = await mkdtemp(join(tmpdir(), "lore-core-consumer-"));
  try {
    const isolatedPackage = join(consumerDirectory, "node_modules/@corespeed/lore-core");
    await mkdir(isolatedPackage, { recursive: true });
    await cp(new URL("package.json", packageUrl), join(isolatedPackage, "package.json"));
    await cp(new URL("src/", packageUrl), join(isolatedPackage, "src"), { recursive: true });
    await cp(
      new URL("fixtures/provider-consumer.ts", import.meta.url),
      join(consumerDirectory, "consumer.ts"),
    );
    const { stdout } = await execute("bun", ["--no-install", "--no-env-file", "consumer.ts"], {
      cwd: consumerDirectory,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      timeout: 20_000,
    });
    expect(stdout.trim()).toBe("independent core consumer passed");
  } finally {
    await rm(consumerDirectory, { recursive: true, force: true });
  }
});

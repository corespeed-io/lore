import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { checkDesignSystem } from "./check-design-system.ts";

const TOKENS = [
  "--canvas",
  "--surface",
  "--ink",
  "--body",
  "--mute",
  "--faint",
  "--hairline",
  "--hairline-soft",
  "--link",
  "--danger",
  "--font-sans",
  "--font-mono",
];

const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

function write(root: string, path: string, contents = "export {};\n") {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "lore-design-"));
  fixtureRoots.add(root);
  write(root, "DESIGN.md", "# Lore design system\n");
  write(
    root,
    "src/app/globals.css",
    `:root { ${TOKENS.map((token) => `${token}: x;`).join(" ")} }`,
  );
  write(root, "src/shell/App.tsx");
  write(root, "src/shell/Sidebar.tsx");
  write(root, "src/modules/graph/browser/GraphView.tsx");
  write(root, "src/modules/memories/browser/SearchResults.tsx");
  write(root, "src/modules/memories/browser/MemoryView.tsx");
  write(root, "src/shared/browser/sdk.ts");
  write(root, "src/app/[...path]/page.tsx");
  write(root, "src/server/api/app.ts");
  write(root, "packages/lore-core/src/graph.ts");
  return root;
}

test("accepts the canonical design-system topology", () => {
  const root = fixture();
  assert.deepEqual(checkDesignSystem(root), []);
});

test("rejects a feature stylesheet", () => {
  const root = fixture();
  write(root, "src/components/memories.css", ".memory {}\n");
  assert.ok(checkDesignSystem(root).some((item) => item.includes("feature stylesheets")));
});

test("rejects missing tokens", () => {
  const root = fixture();
  write(root, "src/app/globals.css", ":root { --canvas: #fafafa; }\n");
  assert.ok(checkDesignSystem(root).some((item) => item.includes("--font-mono")));
});

test("rejects retired classes", () => {
  const root = fixture();
  write(
    root,
    "src/components/feature.tsx",
    'export const Feature = () => <div className="memory-ledger" />;\n',
  );
  const findings = checkDesignSystem(root);
  assert.ok(findings.some((item) => item.includes("memory-ledger")));
});

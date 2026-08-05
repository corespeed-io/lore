import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { checkDesignSystem } from "./check-design-system.mjs";

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

function write(root, path, contents = "export {};\n") {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "lore-design-"));
  write(root, "DESIGN.md", "# Lore design system\n");
  write(
    root,
    "src/app/globals.css",
    `:root { ${TOKENS.map((token) => `${token}: x;`).join(" ")} }`,
  );
  write(root, "src/components/lore-sidebar.tsx");
  write(root, "src/components/ui/button.tsx");
  write(root, "src/components/ui/icons.tsx");
  return root;
}

test("accepts the canonical design-system topology", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(checkDesignSystem(root), []);
});

test("rejects a feature stylesheet", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "src/components/memories.css", ".memory {}\n");
  assert.ok(checkDesignSystem(root).some((item) => item.includes("feature stylesheets")));
});

test("rejects missing tokens", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "src/app/globals.css", ":root { --canvas: #fafafa; }\n");
  assert.ok(checkDesignSystem(root).some((item) => item.includes("--font-mono")));
});

test("rejects inline styles and retired classes", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "src/components/feature.tsx",
    'export const Feature = () => <div className="memory-ledger" style={{ color: "red" }} />;\n',
  );
  const findings = checkDesignSystem(root);
  assert.ok(findings.some((item) => item.includes("inline styles")));
  assert.ok(findings.some((item) => item.includes("memory-ledger")));
});

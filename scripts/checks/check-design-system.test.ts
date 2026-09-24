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
  write(root, "docs/DESIGN.md", "# Lore design system\n");
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

test.each([
  ["braced string", 'export const A = () => <div className={"memory-rail"} />;\n'],
  [
    "template literal",
    `export const A = (x: string) => <div className={\`card \${x} drawer-panel\`} />;\n`,
  ],
  ["ternary", 'export const A = (on: boolean) => <i className={on ? "scope-pill" : "pill"} />;\n'],
  [
    "cn() argument",
    'declare const cn: (...v: unknown[]) => string;\nexport const c = cn("row", true && "ledger-heading");\n',
  ],
  [
    "clsx() object key",
    'declare const clsx: (v: object) => string;\nexport const c = clsx({ "memory-ledger": true });\n',
  ],
  [
    "nested template",
    `export const c = (x: boolean) => \`row \${x ? \`on \${"memory-rail"}\` : ""}\`;\n`,
  ],
  ["selector string", 'export const node = () => document.querySelector("aside.drawer-panel");\n'],
])("rejects a retired class assembled through a %s", (_form, source) => {
  const root = fixture();
  write(root, "src/components/feature.tsx", source);
  const findings = checkDesignSystem(root);
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0] ?? "", /^src\/components\/feature\.tsx:\d+ retired class /);
});

test("reports the line of a retired class inside a multi-line template literal", () => {
  const root = fixture();
  write(
    root,
    "src/components/feature.tsx",
    `export const c = (x: string) => \`\n  card\n  \${x}\n  memory-rail\n\`;\n`,
  );
  assert.deepEqual(
    checkDesignSystem(root).map((item) => item.split(" ")[0]),
    ["src/components/feature.tsx:4"],
  );
});

test("ignores comments, identifiers, and longer class names that only contain a retired token", () => {
  const root = fixture();
  write(
    root,
    "src/components/feature.tsx",
    [
      "// memory-rail was retired in favour of the canonical shell.",
      '/* className="drawer-panel" */',
      "const memoryRail = 1;",
      `export const c = ["memory-rail-v2", "scope-pills", "x-ledger-heading", \`\${memoryRail}\`];`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(checkDesignSystem(root), []);
});

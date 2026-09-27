import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { checkImportBoundaries, classify, scanImports } from "./check-import-boundaries.ts";

const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), "lore-imports-"));
  fixtureRoots.add(root);
  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = resolve(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return root;
}

const TWO_MODULES = {
  alpha: { dependsOn: ["beta"], exports: [] },
  beta: { dependsOn: [], exports: ["service.ts", "browser/data.ts"] },
};

const CLEAN = {
  "src/modules/alpha/service.ts":
    'import { beta } from "@/modules/beta/service";\nexport const alpha = beta;\n',
  "src/modules/alpha/browser/View.tsx":
    'import { useBeta } from "@/modules/beta/browser/data";\nexport const View = useBeta;\n',
  "src/modules/beta/service.ts": "export const beta = 1;\n",
  "src/modules/beta/internal.ts": "export const hidden = 1;\n",
  "src/modules/beta/browser/data.ts": "export const useBeta = 1;\n",
};

test("the declared module graph and layers pass", () => {
  assert.deepEqual(checkImportBoundaries(fixture(CLEAN), TWO_MODULES), []);
});

test("scanning keeps type-only, multi-line, side-effect, and dynamic imports", () => {
  const imports = scanImports(
    [
      'import type { A } from "./a";',
      "import {",
      "  b,",
      "  c,",
      '} from "./b";',
      'import "./side-effect";',
      'export * from "./re-export";',
      '// import { commented } from "./commented";',
      "/* import { blocked } from './blocked'; */",
      'const lazy = await import("./lazy");',
      'const text = "import nothing from here";',
    ].join("\n"),
  );
  assert.deepEqual(
    imports.map(({ specifier, line, typeOnly }) => [specifier, line, typeOnly]),
    [
      ["./a", 1, true],
      ["./b", 2, false],
      ["./side-effect", 6, false],
      ["./re-export", 7, false],
      ["./lazy", 10, false],
    ],
  );
});

test("a lower layer importing a higher one fails, even for a type", () => {
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/server/database/store.ts": 'import type { beta } from "@/modules/beta/service";\n',
      "src/modules/beta/browser/leak.ts": 'import type { beta } from "@/modules/beta/service";\n',
      "packages/lore-core/src/index.ts": 'import { x } from "../../../scripts/helper.ts";\n',
      "scripts/helper.ts": "export const x = 1;\n",
    }),
    TWO_MODULES,
  );
  assert.ok(
    findings.some((item) => item.startsWith("src/server/database/store.ts:1: server-infra")),
  );
  assert.ok(
    findings.some((item) => item.startsWith("src/modules/beta/browser/leak.ts:1: module-ui")),
  );
  assert.ok(findings.some((item) => item.includes("outside src/ and packages/")));
});

test("an undeclared module dependency or an internal file fails", () => {
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/modules/alpha/service.ts": 'import { hidden } from "@/modules/beta/internal";\n',
      "src/modules/beta/service.ts": 'import { alpha } from "@/modules/alpha/service";\n',
    }),
    TWO_MODULES,
  );
  assert.ok(findings.some((item) => item.includes("is internal to module beta")));
  assert.ok(
    findings.some((item) => item.includes("module beta does not declare a dependency on alpha")),
  );
});

test("the module graph must be acyclic, complete, and used", () => {
  const findings = checkImportBoundaries(
    fixture({ ...CLEAN, "src/modules/gamma/service.ts": "export {};\n" }),
    {
      alpha: { dependsOn: ["beta"], exports: ["missing.ts"] },
      beta: { dependsOn: ["alpha"], exports: ["service.ts", "browser/data.ts", "internal.ts"] },
    },
  );
  assert.ok(findings.some((item) => item.includes("dependency cycle")));
  assert.ok(findings.includes("module graph: src/modules/gamma is not declared"));
  assert.ok(findings.includes("module graph: alpha exports missing file missing.ts"));
  assert.ok(findings.includes("module graph: beta declares an unused dependency on alpha"));
  assert.ok(
    findings.includes("module graph: beta exports internal.ts, which no other module imports"),
  );
});

test("the Worker bundle may not reach native or Bun-only packages through value imports", () => {
  const root = fixture({
    ...CLEAN,
    "src/worker/cloudflare.ts": 'import { run } from "@/server/database/runner";\n',
    "src/server/database/runner.ts":
      'import type { Lang } from "@ast-grep/napi";\nimport { spawn } from "node:child_process";\nexport const run = spawn;\n',
  });
  const findings = checkImportBoundaries(root, TWO_MODULES);
  assert.equal(findings.filter((item) => item.includes("Worker bundle")).length, 1);
  assert.ok(
    findings.some((item) =>
      item.includes(
        "reaches node:child_process via src/worker/cloudflare.ts -> src/server/database/runner.ts",
      ),
    ),
  );
});

test("every scanned file belongs to a layer", () => {
  assert.equal(classify("src/modules/code/browser/data.ts")?.layer, "module-ui");
  assert.equal(classify("src/modules/code/indexing/read.ts")?.modulePath, "indexing/read.ts");
  assert.equal(classify("src/app/api/[[...path]]/route.ts")?.layer, "server-composition");
  assert.equal(classify("src/app/page.tsx")?.layer, "page");
  assert.equal(classify("src/server/api/app.ts")?.layer, "server-composition");
  assert.equal(classify("src/server/api/input.ts")?.layer, "server-infra");
  const findings = checkImportBoundaries(
    fixture({ ...CLEAN, "src/stray.ts": "export {};\n" }),
    TWO_MODULES,
  );
  assert.ok(
    findings.includes(
      "src/stray.ts: file belongs to no layer; classify it in check-import-boundaries.ts",
    ),
  );
});

test("a comment opener inside a line comment or a string hides no later import", () => {
  const imports = scanImports(
    [
      "// Routes `/api/*` go to Hono.",
      'import { spawn } from "node:child_process";',
      'const glob = "docs/*";',
      'const url = "https://lore.local"; // trailing comment',
      'const lazy = import("./lazy");',
      "/** Worker entry. */",
      '/* import { hidden } from "./commented-out"; */',
    ].join("\n"),
  );
  assert.deepEqual(
    imports.map((item) => [item.specifier, item.line]),
    [
      ["node:child_process", 2],
      ["./lazy", 5],
    ],
  );
});

test("a comment opener inside a regex literal hides no later import", () => {
  const imports = scanImports(
    [
      "const TRAILING_SLASHES = /\\/*$/;",
      'const lazy = import("node:child_process");',
      'const end = "*/";',
      'const URL_RE = /https?:\\/\\//; const later = import("bun:sqlite");',
      'const ratio = total / count; // import("./commented-out")',
    ].join("\n"),
  );
  assert.deepEqual(
    imports.map((item) => [item.specifier, item.line]),
    [
      ["node:child_process", 2],
      ["bun:sqlite", 4],
    ],
  );
});

test("a JSX tag before a template literal hides no later import", () => {
  const closing = scanImports(
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
      "export const A = ({ x }: { x: string }) => <p><b>a</b>{`${x}/y`}</p>;",
      "const glob = `src/*`;",
      'export const load = () => import("bun");',
      "const end = `*/`;",
    ].join("\n"),
  );
  assert.deepEqual(
    closing.map((item) => item.specifier),
    ["bun"],
  );
  const selfClosing = scanImports(
    [
      "export const B = ({ x }: { x: string }) => <p><b>a</b> <a href={`/x`}>x</a><i {...x} /></p>;",
      'const docs = `https://example.com`; void import("bun");',
    ].join("\n"),
  );
  assert.deepEqual(
    selfClosing.map((item) => item.specifier),
    ["bun"],
  );
  const fragment = scanImports(
    [
      "export const C = () => <><p>x</p><b>{`a/b`}</b></>;",
      "const glob = `src/*`;",
      'import { Database } from "bun:sqlite";',
      "const end = `*/`;",
    ].join("\n"),
  );
  assert.deepEqual(
    fragment.map((item) => item.specifier),
    ["bun:sqlite"],
  );
});

test("template-literal imports and require() are scanned", () => {
  const imports = scanImports(
    [
      "const napi = await import(`@ast-grep/napi`);",
      'const cp = require("node:child_process");',
      'import fs = require("node:fs");',
      'const plugin = loader.require("not-a-module");',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
      "const dynamic = await import(`./${name}`);",
    ].join("\n"),
  );
  assert.deepEqual(
    imports.map((item) => [item.specifier, item.line]),
    [
      ["@ast-grep/napi", 1],
      ["node:child_process", 2],
      ["node:fs", 3],
    ],
  );
});

test("the Worker check follows wrangler.jsonc main and refuses a missing entry", () => {
  const renamed = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "wrangler.jsonc": '{\n  // The Worker entry.\n  "main": "src/worker/entry.ts"\n}\n',
      "src/worker/entry.ts": 'import { spawn } from "node:child_process";\nexport { spawn };\n',
    }),
    TWO_MODULES,
  );
  assert.ok(
    renamed.includes(
      "src/worker/entry.ts: the Worker bundle reaches node:child_process via src/worker/entry.ts",
    ),
  );
  const missing = checkImportBoundaries(
    fixture({ ...CLEAN, "wrangler.jsonc": '{ "main": "src/worker/gone.ts" }\n' }),
    TWO_MODULES,
  );
  assert.ok(
    missing.includes(
      'wrangler.jsonc: the Worker entry "src/worker/gone.ts" is not a scanned source file',
    ),
  );
});

test("the Worker check covers the App Router files OpenNext bundles with its entry", () => {
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/app/api/native/route.ts":
        'import { parse } from "@/server/native";\nexport const GET = parse;\n',
      "src/server/native.ts": 'import { parse } from "@ast-grep/napi";\nexport { parse };\n',
    }),
    TWO_MODULES,
  );
  assert.ok(
    findings.includes(
      "src/app/api/native/route.ts: the Worker bundle reaches @ast-grep/napi via src/app/api/native/route.ts -> src/server/native.ts",
    ),
  );
});

test("a Worker entry fails closed on Bun built-ins, unresolved imports, and a missing main", () => {
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/worker/cloudflare.ts": [
        'import "./styles.css";',
        // A `/*` inside a template literal must not open a comment that hides the
        // Bun-only import below it until the `*/` in the next template.
        "const glob = `src/*`;",
        'import { Database } from "bun:sqlite";',
        "const end = `*/`;",
        'import { gone } from "@/server/missing";',
        "export { Database, end, glob, gone };",
      ].join("\n"),
    }),
    TWO_MODULES,
  );
  assert.ok(
    findings.includes(
      "src/worker/cloudflare.ts: the Worker bundle reaches bun:sqlite via src/worker/cloudflare.ts",
    ),
  );
  assert.ok(findings.includes("src/worker/cloudflare.ts:5: cannot resolve @/server/missing"));
  // A stylesheet is an asset, not a module dependency.
  assert.ok(!findings.some((item) => item.includes("styles.css")));

  // A wrangler.jsonc without `main` cannot switch the Worker check off.
  const withoutMain = checkImportBoundaries(
    fixture({ ...CLEAN, "wrangler.jsonc": '{ "name": "lore" }\n' }),
    TWO_MODULES,
  );
  assert.ok(
    withoutMain.includes('wrangler.jsonc: the Worker entry "" is not a scanned source file'),
  );
});

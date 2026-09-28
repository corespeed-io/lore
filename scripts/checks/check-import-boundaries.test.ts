import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  checkImportBoundaries,
  classify,
  computedImports,
  scanImports,
} from "./check-import-boundaries.ts";

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
  // A finding names the line that writes the specifier.
  assert.deepEqual(
    imports.map(({ specifier, line, typeOnly }) => [specifier, line, typeOnly]),
    [
      ["./a", 1, true],
      ["./b", 5, false],
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

test("an arrow's regex literal, or one holding a backtick, hides no later import", () => {
  for (const regex of [
    "export const trailing = (s: string) => /\\/*$/.test(s);",
    'export const inlineCode = (s: string) => s.replace(/`([^`]+)`/g, "<code>$1</code>");',
    'export const plain = (s: string) => s.replace(/[#*`>]/g, "");',
    "const HTTP_TOKEN = /^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$/;",
  ]) {
    const imports = scanImports(
      [
        regex,
        "const glob = `src/*`;",
        'export const load = () => import("bun");',
        "const end = `*/`;",
      ].join("\n"),
    );
    assert.deepEqual(
      imports.map((item) => item.specifier),
      ["bun"],
      regex,
    );
  }
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

test("shapes a regex lexer misreads hide no value import from the parser", () => {
  for (const source of [
    'export const Help = () => <p>Match src/*.ts files</p>;\nexport const load = () => import("bun");\n/** doc */',
    'export const Link = () => <p>see https://x.dev</p>; const load = () => import("bun");',
    'export function f(ok: boolean, s: string) { if (ok) /\\/*x/.test(s); return import("bun"); }\n/** doc */',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
    'const a = `${Math.random() > 0.5 ? `x` : `y/*`}`;\nexport const load = () => import("bun");\nconst end = "*/";',
  ]) {
    assert.deepEqual(
      scanImports(source)
        .filter((item) => !item.typeOnly)
        .map((item) => item.specifier),
      ["bun"],
      source,
    );
    // The same shapes hide no type-only import either.
    assert.deepEqual(
      scanImports(
        `${source.replace('import("bun")', "0")}\nexport type { X } from "@/server/x";`,
      ).map((item) => [item.specifier, item.typeOnly]),
      [["@/server/x", true]],
      source,
    );
  }
});

test("type-only imports stay type-only, and an unparsable file is a finding", () => {
  const imports = scanImports(
    'import type { A } from "./a";\nexport type { B } from "./b";\nimport { c } from "./c";\nexport const d = c;\n',
    "ts",
  );
  assert.deepEqual(
    imports.map((item) => [item.specifier, item.line, item.typeOnly]),
    [
      ["./a", 1, true],
      ["./b", 2, true],
      ["./c", 3, false],
    ],
  );
  const findings = checkImportBoundaries(
    fixture({ ...CLEAN, "src/modules/beta/broken.ts": "export const = ;\n" }),
    TWO_MODULES,
  );
  // The finding names the parser's position, not only that parsing failed.
  assert.ok(
    findings.some((item) =>
      /^src\/modules\/beta\/broken\.ts: cannot be parsed for imports: 1:\d+ /.test(item),
    ),
    findings.join("\n"),
  );
});

test("an all-inline-type import still loads its module, so the Worker ban counts it", () => {
  // Under verbatimModuleSyntax `import { type Lang } from "x"` compiles to
  // `import {} from "x"`, which still bundles x.
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/worker/cloudflare.ts":
        'import { run } from "@/server/database/runner";\nexport default run;\n',
      "src/server/database/runner.ts":
        'import { type Lang } from "@ast-grep/napi";\nexport { type ChildProcess } from "node:child_process";\nexport const run = (lang?: Lang) => lang;\n',
    }),
    TWO_MODULES,
  );
  for (const name of ["@ast-grep/napi", "node:child_process"]) {
    assert.ok(
      findings.some((item) => item.includes(`the Worker bundle reaches ${name}`)),
      name,
    );
  }
});

test("a comment beside a type modifier changes nothing", () => {
  assert.deepEqual(
    scanImports(
      [
        'import { /* explanation */ type SpawnOptions } from "node:child_process";',
        'import { type /* why */ Lang } from "@ast-grep/napi";',
        'import /* only for types */ type { X } from "./x";',
        'export // re-exported types\n  type { Y } from "./y";',
      ].join("\n"),
      "ts",
    ).map((item) => [item.specifier, item.typeOnly]),
    [
      ["node:child_process", false],
      ["@ast-grep/napi", false],
      ["./x", true],
      ["./y", true],
    ],
  );
});

test("a specifier written with escapes is the module it names", () => {
  assert.deepEqual(
    scanImports('import "\\x62un";\nimport { s } from "node:child\\u005Fprocess";\ns;\n', "ts")
      .filter((item) => !item.typeOnly)
      .map((item) => item.specifier),
    ["bun", "node:child_process"],
  );
});

test("the Edge middleware may not reach the engine or the API layer", () => {
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/middleware.ts":
        'import { authorize } from "@/server/auth/auth";\nexport const middleware = authorize;\n',
      "src/server/auth/auth.ts":
        'import { errorResponse } from "@/server/api/errors";\nexport const authorize = errorResponse;\n',
      "src/server/api/errors.ts": "export const errorResponse = 1;\n",
    }),
    TWO_MODULES,
  );
  assert.ok(
    findings.includes(
      "src/middleware.ts: the Edge middleware reaches src/server/api/errors.ts via src/middleware.ts -> src/server/auth/auth.ts -> src/server/api/errors.ts",
    ),
  );
});

test("a module the guard cannot scan is a finding", () => {
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/worker/cloudflare.ts": 'import { run } from "./svc.mts";\nexport default run;\n',
      "src/worker/svc.mts":
        'import { spawn } from "node:child_process";\nexport const run = spawn;\n',
    }),
    TWO_MODULES,
  );
  assert.ok(
    findings.includes(
      "src/worker/cloudflare.ts:1: imports src/worker/svc.mts, which this guard does not scan",
    ),
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

test("an import() with a computed specifier is a finding, and one merely mentioned is not", () => {
  assert.deepEqual(
    computedImports(
      [
        'const name = "fs";',
        'await import("node:" + name);',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
        "await import(`./plugins/${name}.ts`);",
        "await import( /* dynamic */ name );",
        'await import("./literal");',
        "await import(`./template-without-substitutions`);",
        'const note = "use import(name) sparingly";',
        "// await import(name)",
        "const pattern = /import\\(x\\)/;",
      ].join("\n"),
    ),
    [
      'import("node:" + name)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
      "import(`./plugins/${name}.ts`)",
      "import(name)",
    ],
  );
  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/modules/beta/service.ts":
        'export const beta = 1;\nexport const load = (name: string) => import("./" + name);\n',
    }),
    TWO_MODULES,
  );
  assert.ok(
    findings.includes(
      'src/modules/beta/service.ts: import("./" + name) has a computed specifier that no scan can check; import a string literal',
    ),
  );
});

test("an import() whose literal parts Bun folds into one specifier is still a finding", () => {
  const folded = [
    'await import("@/modules/beta/" + "internal");',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
    'await import(`node:${"child_process"}`);',
  ];
  const found = computedImports(folded.join("\n"));
  assert.equal(found.length, 2);
  assert.ok(found.every((expression) => expression.startsWith("import(")));
  // The folded edge is invisible to the scan too, which is why it must be refused.
  assert.deepEqual(scanImports(folded.join("\n")), []);
  // The same text quoted elsewhere, as a decoy, does not make the folded import an edge.
  assert.equal(
    computedImports(
      ['// see "@/modules/beta/internal"', 'const decoy = "node:child_process";', ...folded].join(
        "\n",
      ),
    ).length,
    2,
  );

  const findings = checkImportBoundaries(
    fixture({
      ...CLEAN,
      "src/modules/alpha/service.ts": [
        'import { beta } from "@/modules/beta/service";',
        "export const alpha = beta;",
        'export const load = () => import("@/modules/beta/" + "internal");',
        "",
      ].join("\n"),
    }),
    TWO_MODULES,
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.startsWith("src/modules/alpha/service.ts: import(") &&
        finding.endsWith(
          "has a computed specifier that no scan can check; import a string literal",
        ),
    ),
    findings.join("\n"),
  );
});

test("a computed import() in a branch Bun would prove dead is found in every environment", () => {
  const source = [
    "export async function load(name: string) {",
    '  if (process.env.NODE_ENV === "production") return import(name);',
    '  return import("./development");',
    "}",
  ].join("\n");
  const previous = process.env.NODE_ENV;
  try {
    for (const environment of [undefined, "production", "development"]) {
      if (environment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = environment;
      assert.deepEqual(computedImports(source, "ts"), ["import(name)"], String(environment));
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("import.meta, a type-position import(), and a shebang are not computed imports", () => {
  assert.deepEqual(
    computedImports(
      [
        "#!/usr/bin/env bun",
        'const here = new URL("./data.json", import.meta.url);',
        'type Loaded = typeof import("./literal-type");',
        "let loaded: Loaded | undefined;",
        "export { here, loaded };",
      ].join("\n"),
      "ts",
    ),
    [],
  );
  // The shebang is blanked, not the line after it, so a computed import there counts.
  assert.deepEqual(computedImports("#!/usr/bin/env bun\nawait import(process.argv[2]);", "ts"), [
    "import(process.argv[2])",
  ]);
});

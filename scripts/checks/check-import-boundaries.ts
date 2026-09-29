import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync as initModuleLexer, parse as lexModule } from "es-module-lexer";

/**
 * Layered import boundaries for src/ and packages/. Every file belongs to exactly
 * one layer; a layer may import only the layers listed for it. Cross-domain
 * imports additionally follow the declared module graph below: a module may
 * import another only when it declares that dependency, and only the files that
 * module exports. There is no baseline of tolerated violations.
 */
type Layer =
  | "core"
  | "sdk"
  | "cli"
  | "mcp"
  | "server-infra"
  | "module-server"
  | "server-composition"
  | "ui-infra"
  | "module-ui"
  | "ui-composition"
  | "page";

const ALLOWED_LAYERS: Record<Layer, readonly Layer[]> = {
  core: ["core"],
  sdk: ["sdk"],
  cli: ["cli", "sdk"],
  mcp: ["mcp", "sdk"],
  "server-infra": ["server-infra", "core"],
  "module-server": ["module-server", "server-infra", "core"],
  "server-composition": ["server-composition", "module-server", "server-infra", "core"],
  "ui-infra": ["ui-infra", "sdk"],
  "module-ui": ["module-ui", "ui-infra", "sdk"],
  "ui-composition": ["ui-composition", "module-ui", "ui-infra", "sdk"],
  // Next pages and layouts are Server Components: they read deployment config and
  // render the client shell.
  page: ["ui-composition", "module-ui", "ui-infra", "sdk", "server-infra"],
};

interface ModuleDeclaration {
  /** Modules this one may import. The graph must stay acyclic. */
  dependsOn: readonly string[];
  /** Module-relative files other modules may import. Composition layers may import any file. */
  exports: readonly string[];
}

export const MODULES: Record<string, ModuleDeclaration> = {
  agents: { dependsOn: [], exports: ["browser/data.ts"] },
  code: {
    dependsOn: [],
    exports: [
      "evidence.ts",
      "evidence-contract.ts",
      "graph.ts",
      "openapi.ts",
      "indexing/protocol.ts",
      "indexing/read.ts",
      "indexing/types.ts",
      "indexing/validation.ts",
      "browser/data.ts",
      "browser/evidence-presentation.ts",
      "browser/job-presentation.ts",
    ],
  },
  context: { dependsOn: ["code", "memories"], exports: [] },
  episodes: { dependsOn: [], exports: ["browser/data.ts"] },
  evaluations: { dependsOn: ["memories"], exports: [] },
  graph: { dependsOn: ["memories"], exports: [] },
  memories: {
    dependsOn: ["code"],
    exports: ["input.ts", "service.ts", "browser/data.ts", "browser/presentation.ts"],
  },
  operations: { dependsOn: ["code", "portability", "proposals", "workspaces"], exports: [] },
  portability: {
    dependsOn: ["memories"],
    exports: ["limits.ts", "browser/data.ts", "browser/presentation.ts"],
  },
  proposals: {
    dependsOn: ["agents", "code", "episodes", "memories"],
    exports: ["limits.ts"],
  },
  workspaces: { dependsOn: [], exports: ["browser/data.ts"] },
};

/**
 * The Cloudflare Worker bundle's entry: wrangler.jsonc `main`, so a renamed entry
 * cannot switch the check off. Nothing it reaches may need native code or a child
 * process. A root without wrangler.jsonc (a test fixture) uses the default path.
 */
const DEFAULT_WORKER_ENTRYPOINT = "src/worker/cloudflare.ts";

function workerEntrypoint(root: string): { entrypoint: string; declared: boolean } {
  const config = resolve(root, "wrangler.jsonc");
  if (!existsSync(config)) return { entrypoint: DEFAULT_WORKER_ENTRYPOINT, declared: false };
  const main = /"main"\s*:\s*"([^"]+)"/.exec(readFileSync(config, "utf8"))?.[1];
  return { entrypoint: (main ?? "").replace(/^\.\//, ""), declared: true };
}
/** Bun's parse errors, with their positions, or the error itself. */
function parseFailure(error: unknown): string {
  const errors = (
    error as {
      errors?: Array<{ message?: string; position?: { line?: number; column?: number } | null }>;
    }
  )?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return String(error);
  return errors
    .map((item) =>
      `${item.position?.line ?? "?"}:${item.position?.column ?? "?"} ${item.message ?? ""}`.trim(),
    )
    .join("; ");
}

/** The Edge middleware entry, and what nothing it reaches may be. */
const EDGE_ENTRYPOINT = "src/middleware.ts";
const EDGE_FORBIDDEN_PREFIXES = ["packages/lore-core/", "src/server/api/"];

/**
 * Visit every edge reachable from `root` over value imports, with the chain of files
 * that leads to it. Each file is expanded once.
 */
function forEachReachableEdge(
  valueEdges: Map<string, Resolution[]>,
  root: string,
  visit: (edge: Resolution, chain: string[]) => void,
): void {
  const parents = new Map<string, string>();
  const queue = [root];
  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.shift() as string;
    const chain = [file];
    for (let parent = parents.get(file); parent; parent = parents.get(parent)) {
      chain.unshift(parent);
    }
    for (const edge of valueEdges.get(file) ?? []) {
      visit(edge, edge.file === null ? chain : [...chain, edge.file]);
      if (edge.file === null || seen.has(edge.file) || !valueEdges.has(edge.file)) continue;
      seen.add(edge.file);
      parents.set(edge.file, file);
      queue.push(edge.file);
    }
  }
}

/** A file OpenNext compiles into the Worker bundle beside the wrangler entry. */
function isOpenNextInput(file: string): boolean {
  return (
    file.startsWith("src/app/") || file === "src/instrumentation.ts" || file === "src/middleware.ts"
  );
}
const WORKER_FORBIDDEN_PACKAGES = ["@ast-grep/napi", "node:child_process", "child_process", "bun"];

function forbiddenInWorker(name: string): boolean {
  return WORKER_FORBIDDEN_PACKAGES.includes(name) || name.startsWith("bun:");
}

const SERVER_COMPOSITION_FILES = new Set([
  "src/server/api/app.ts",
  "src/server/api/cloudflare.ts",
  "src/server/api/next.ts",
  "src/server/openapi/document.ts",
  "src/instrumentation.ts",
  "src/middleware.ts",
]);

const WORKSPACE_PACKAGES: Record<string, string> = {
  "@corespeed/lore-sdk": "packages/typescript-sdk/src/index.ts",
  "@corespeed/lore-cli": "packages/cli/src/index.ts",
  "@corespeed/lore-mcp": "packages/mcp/src/index.ts",
};

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const GENERATED_OUTPUT = /(^|\/)\.open-next\//;
const ASSET_IMPORT = /\.(css|svg|png|jpe?g|gif|webp|json|txt|md)$/;
const SCANNED_ROOTS = ["src", "packages"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".next", ".open-next"]);

export interface ImportRecord {
  specifier: string;
  line: number;
  typeOnly: boolean;
}

/** What the check's transpile turns each module-loading global into. */
const REQUIRE = "__lore_require__";
const META_REQUIRE = "__lore_import_meta_require__";
const BUILTIN = "__lore_get_builtin_module__";

/**
 * Bun's `define` replaces every reference its parser sees to the global `require`, so
 * an alias, `(0, require)`, `require.call`, an optional call, or `typeof require` is
 * found and a string cannot fake one. For the dotted keys it matches only that exact
 * member chain: `process["getBuiltinModule"]`, an alias of `process`, or
 * `import { getBuiltinModule } from "node:process"` is not replaced. It never replaces
 * a locally bound name, and Bun keeps `module` for CommonJS interop, so `define`
 * cannot name `module` at all.
 */
const LOADER_DEFINE = {
  require: REQUIRE,
  "import.meta.require": META_REQUIRE,
  "process.getBuiltinModule": BUILTIN,
  "globalThis.process.getBuiltinModule": BUILTIN,
};

/**
 * Without dead-code elimination: by default Bun inlines `process.env.NODE_ENV` and
 * drops the branch it proves dead, so the JavaScript `computedImports` lexes would
 * hide a load there depending on the environment the check runs in. The import scan
 * never removed dead code, and `define` does not change what it reports.
 */
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts", deadCodeElimination: false, define: LOADER_DEFINE }),
  tsx: new Bun.Transpiler({ loader: "tsx", deadCodeElimination: false, define: LOADER_DEFINE }),
};

/** The JSX runtime Bun reports for a TSX file that never names it. */
const INJECTED = new Set(
  TRANSPILERS.tsx.scanImports("export const a = <a />;").map((item) => item.path),
);

// `import type` and `export type` statements, which the compiler erases, and inline
// `type` modifiers inside an import or export clause. Under verbatimModuleSyntax an
// all-inline-type clause still loads its module (`import {} from`), so only the
// statement form makes an import type-only. A comment may sit wherever whitespace
// does, so the patterns treat one as whitespace.
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))`;
const STATEMENT_TYPE = new RegExp(
  String.raw`\b(?:import${GAP}+type(?=${GAP}+(?:[{*]|[A-Za-z_$][\w$]*${GAP}*(?:,|from\b)))|export${GAP}+type(?=${GAP}*[{*]))`,
  "g",
);
const IMPORT_CLAUSE = new RegExp(
  String.raw`\b(?:import|export)${GAP}+(?:type${GAP}+)?\{[^}]*\}`,
  "g",
);
const INLINE_TYPE = new RegExp(String.raw`([{,]${GAP}*)type(?=${GAP}+[A-Za-z_$])`, "g");

/** Blank the inline `type` modifiers, keeping every offset. */
function withoutInlineTypes(source: string): string {
  return source.replace(IMPORT_CLAUSE, (clause) =>
    clause.replace(INLINE_TYPE, (_modifier, lead: string) => `${lead}    `),
  );
}

/** Blank every `type` modifier, statement and inline, keeping every offset. */
function withoutTypeModifiers(source: string): string {
  return withoutInlineTypes(source).replace(STATEMENT_TYPE, (statement) =>
    statement.replace(/type$/, "    "),
  );
}

function quotedIn(source: string, specifier: string): boolean {
  return ['"', "'", "`"].some((quote) => source.includes(`${quote}${specifier}${quote}`));
}

/** The specifiers Bun's parser reports, without a JSX runtime the file never names. */
function parsedSpecifiers(transpiler: Bun.Transpiler, source: string, original: string): string[] {
  return transpiler
    .scanImports(source)
    .map((item) => item.path)
    .filter((specifier) => !INJECTED.has(specifier) || quotedIn(original, specifier));
}

initModuleLexer();

/** `createRequire` loads a module by any name, so no source file may import it. */
const NODE_MODULE_SPECIFIERS = new Set(["module", "node:module"]);

/**
 * A direct `require` call of one double-quoted string literal or template with no
 * substitution, as Bun prints most literals. Bun prints a literal that contains `"`
 * single-quoted, which this does not accept, so such a `require` is a finding even
 * though the scan reports it.
 */
const LITERAL_REQUIRE = new RegExp(
  `^${REQUIRE}\\((?:("(?:[^"\\\\]|\\\\.)*")|\`([^\`\\\\$]*)\`)\\)`,
);

/**
 * `require` calls `define` leaves as written: a locally bound `require`, the bare
 * `require(` Bun prints for `module.require(` and `module["require"](`, and
 * `module?.require(`. Each match is rewritten, at the same length, to `import`, so
 * es-module-lexer confirms the real calls and passes over a match inside a string.
 */
const UNDEFINED_LOADS = /(?<![\w$.#])(?:module\s*\?\.\s*)?require(?:\s*\?\.)?(?=\s*\()/g;

/** `import.meta` properties that read a value and load nothing. */
const IMPORT_META_READS =
  /^\s*\??\.\s*(?:url|dirname|filename|dir|path|file|main|env|resolve|hot)\b/;

function readBack(javascript: string): string {
  return javascript
    .replaceAll(META_REQUIRE, "import.meta.require")
    .replaceAll(BUILTIN, "process.getBuiltinModule")
    .replaceAll(REQUIRE, "require");
}

/** The printed line around `index`, with the sentinels read back. */
function printedLine(javascript: string, index: number): string {
  const start = javascript.lastIndexOf("\n", index) + 1;
  const end = javascript.indexOf("\n", index);
  return readBack(javascript.slice(start, end < 0 ? undefined : end).trim());
}

/** The literal a direct `require` call at the start of `javascript` loads, if any. */
function requiredLiteral(javascript: string): string | undefined {
  const match = LITERAL_REQUIRE.exec(javascript);
  if (!match) return undefined;
  return match[1] === undefined ? match[2] : (JSON.parse(match[1]) as string);
}

/**
 * The module loads no scan can check, each a finding rather than an edge the guard
 * silently misses. The intended ways to load a module are a static import, `import()`
 * of a string literal, and `require()` of a string literal the parser's scan
 * reports. This finds:
 * - an `import()` whose specifier is not a string literal, such as
 *   `import("node:" + name)`, or whose literal the scan did not report (Bun folds
 *   `"node:" + "fs"` into one literal it never reports);
 * - every other reference to the global `require`, and `import.meta.require` or
 *   `process.getBuiltinModule` written as that member chain (found by `define`);
 * - every call of a `require` that `define` leaves as written: a locally bound one,
 *   `module.require(`, `module["require"](`, and `module?.require(` (found by the
 *   lexer, below);
 * - `import.meta` used as anything but a read of a known property, so it cannot be
 *   aliased, destructured, or indexed to reach its loader.
 * es-module-lexer reads the JavaScript Bun emits, which has no types or comments, so
 * a string, comment, or regex that mentions a loader is not counted. `node:module`
 * imports, whose `createRequire` loads by any name, are refused where records are
 * checked.
 *
 * It is not a complete sandbox. It does not see `process.getBuiltinModule` reached
 * through an alias, destructuring, an index, `process?.`, or `node:process`; any use
 * of `module` other than those calls; `new Function` or `eval` source; the `Bun`
 * global (`Bun.spawn`); or the target of `new Worker(new URL(...))`, which Turbopack
 * does follow. Code review and the Cloudflare dry run cover those.
 */
export function computedImports(source: string, loader: "ts" | "tsx" = "tsx"): string[] {
  const parsable = source.replace(/^#![^\n]*/, (line) => " ".repeat(line.length));
  const scanned = new Set(TRANSPILERS[loader].scanImports(parsable).map((item) => item.path));
  const javascript = TRANSPILERS[loader].transformSync(parsable);
  const undefinedLoads = new Set<number>();
  const lexable = javascript.replace(UNDEFINED_LOADS, (call: string, index: number) => {
    undefinedLoads.add(index);
    return "import".padEnd(call.length);
  });

  const findings: string[] = [];
  for (const item of lexModule(lexable)[0]) {
    if (undefinedLoads.has(item.ss)) {
      findings.push(printedLine(javascript, item.ss));
    } else if (item.d === -2) {
      if (!IMPORT_META_READS.test(javascript.slice(item.se))) {
        findings.push(printedLine(javascript, item.ss));
      }
    } else if (item.d >= 0 && (item.n === undefined || !scanned.has(item.n))) {
      findings.push(readBack(javascript.slice(item.ss, item.se).replace(/\s+/g, " ")));
    }
  }
  for (const sentinel of [REQUIRE, META_REQUIRE, BUILTIN]) {
    for (
      let at = javascript.indexOf(sentinel);
      at >= 0;
      at = javascript.indexOf(sentinel, at + 1)
    ) {
      const literal = sentinel === REQUIRE ? requiredLiteral(javascript.slice(at)) : undefined;
      if (literal !== undefined && scanned.has(literal)) continue;
      findings.push(printedLine(javascript, at));
    }
  }
  return findings;
}

/**
 * The imports of one source file, all from Bun's TypeScript parser, so no comment,
 * string, regex, or JSX shape can hide one. Bun reports only what loads at run
 * time, so a second parse with every `type` modifier blanked also reports the
 * type-only imports, which a browser file must not use to reach server code either:
 * those count for the layer rules but never for the Worker ban. Lines come from the
 * first written occurrence of each specifier. Throws when the source does not parse.
 */
export function scanImports(source: string, loader: "ts" | "tsx" = "tsx"): ImportRecord[] {
  // Bun's parser refuses a shebang line; blank it so offsets and lines survive.
  const parsable = source.replace(/^#![^\n]*/, (line) => " ".repeat(line.length));
  const transpiler = TRANSPILERS[loader];
  const values = parsedSpecifiers(transpiler, withoutInlineTypes(parsable), source);
  const everything = parsedSpecifiers(transpiler, withoutTypeModifiers(parsable), source);
  const remainingValues = new Map<string, number>();
  for (const specifier of values) {
    remainingValues.set(specifier, (remainingValues.get(specifier) ?? 0) + 1);
  }
  const searchFrom = new Map<string, number>();
  const records: ImportRecord[] = [];
  for (const specifier of everything) {
    const remaining = remainingValues.get(specifier) ?? 0;
    if (remaining > 0) remainingValues.set(specifier, remaining - 1);
    const from = searchFrom.get(specifier) ?? 0;
    const at = ['"', "'", "`"]
      .map((quote) => source.indexOf(`${quote}${specifier}${quote}`, from))
      .filter((index) => index >= 0);
    const index = at.length ? Math.min(...at) : -1;
    if (index >= 0) searchFrom.set(specifier, index + 1);
    // A specifier written with escapes has no literal occurrence; name line 1.
    const line = index >= 0 ? source.slice(0, index).split("\n").length : 1;
    records.push({ specifier, line, typeOnly: remaining === 0 });
  }
  return records.sort((left, right) => left.line - right.line);
}

interface Resolution {
  /** Repository-relative file, or null for an external package. */
  file: string | null;
  packageName: string;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function resolveSourceFile(base: string): string | null {
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => base + extension),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  if (base.endsWith(".js")) return resolveSourceFile(base.slice(0, -3));
  return null;
}

function coreExportMap(root: string): Record<string, string> {
  const manifestPath = join(root, "packages/lore-core/package.json");
  if (!isFile(manifestPath)) return {};
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports?: Record<string, string | { import?: string; default?: string }>;
  };
  const map: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const file = typeof target === "string" ? target : (target.import ?? target.default);
    if (file) map[join("@corespeed/lore-core", subpath)] = join("packages/lore-core", file);
  }
  return map;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function resolver(root: string) {
  const aliases = { ...coreExportMap(root), ...WORKSPACE_PACKAGES };
  return (from: string, specifier: string): Resolution => {
    // The OpenNext build output the Worker wraps is generated, not source, and a
    // stylesheet or other asset import is not a module dependency.
    if (GENERATED_OUTPUT.test(specifier) || ASSET_IMPORT.test(specifier)) {
      return { file: null, packageName: specifier };
    }
    let absolute: string | null = null;
    if (specifier.startsWith("."))
      absolute = resolveSourceFile(resolve(root, dirname(from), specifier));
    else if (specifier.startsWith("@/"))
      absolute = resolveSourceFile(join(root, "src", specifier.slice(2)));
    else if (specifier in aliases) absolute = join(root, aliases[specifier] as string);
    else return { file: null, packageName: packageName(specifier) };
    return {
      file: absolute ? relative(root, absolute) : `unresolved:${specifier}`,
      packageName: "",
    };
  };
}

interface Classification {
  layer: Layer;
  module?: string;
  /** Module-relative path, for export checks. */
  modulePath?: string;
}

export function classify(file: string): Classification | null {
  if (file.startsWith("packages/lore-core/")) return { layer: "core" };
  if (file.startsWith("packages/typescript-sdk/")) return { layer: "sdk" };
  if (file.startsWith("packages/cli/")) return { layer: "cli" };
  if (file.startsWith("packages/mcp/")) return { layer: "mcp" };
  const moduleMatch = /^src\/modules\/([^/]+)\/(.+)$/.exec(file);
  if (moduleMatch) {
    const [, module, modulePath] = moduleMatch as unknown as [string, string, string];
    const layer = modulePath.startsWith("browser/") ? "module-ui" : "module-server";
    return { layer, module, modulePath };
  }
  if (file.startsWith("src/shell/")) return { layer: "ui-composition" };
  if (file.startsWith("src/shared/browser/") || file.startsWith("src/shared/ui/")) {
    return { layer: "ui-infra" };
  }
  if (file.startsWith("src/app/")) {
    const server = file.startsWith("src/app/api/") || /\/route\.tsx?$/.test(file);
    return { layer: server ? "server-composition" : "page" };
  }
  if (file.startsWith("src/worker/") || SERVER_COMPOSITION_FILES.has(file)) {
    return { layer: "server-composition" };
  }
  if (file.startsWith("src/server/")) return { layer: "server-infra" };
  return null;
}

function walk(root: string, directory: string, files: string[]): void {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return;
  for (const name of readdirSync(absolute)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const path = join(directory, name);
    if (statSync(join(root, path)).isDirectory()) walk(root, path, files);
    else if (
      SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
      !name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
}

function moduleCycle(modules: Record<string, ModuleDeclaration>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  function visit(name: string): string[] | null {
    if (state.get(name) === "done") return null;
    if (state.get(name) === "visiting") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "visiting");
    path.push(name);
    for (const dependency of modules[name]?.dependsOn ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(name, "done");
    return null;
  }
  for (const name of Object.keys(modules)) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

export function checkImportBoundaries(
  root: string,
  modules: Record<string, ModuleDeclaration> = MODULES,
): string[] {
  const findings: string[] = [];
  const resolveImport = resolver(root);
  const files: string[] = [];
  for (const directory of SCANNED_ROOTS) walk(root, directory, files);
  files.sort();

  const cycle = moduleCycle(modules);
  if (cycle) findings.push(`module graph: dependency cycle ${cycle.join(" -> ")}`);
  const presentModules = new Set(
    files.map((file) => classify(file)?.module).filter((name): name is string => Boolean(name)),
  );
  for (const name of presentModules) {
    if (!(name in modules)) findings.push(`module graph: src/modules/${name} is not declared`);
  }
  for (const [name, declaration] of Object.entries(modules)) {
    if (!presentModules.has(name))
      findings.push(`module graph: declared module ${name} has no files`);
    for (const dependency of declaration.dependsOn) {
      if (!(dependency in modules)) {
        findings.push(`module graph: ${name} depends on undeclared module ${dependency}`);
      }
    }
    for (const exported of declaration.exports) {
      if (!isFile(join(root, "src/modules", name, exported))) {
        findings.push(`module graph: ${name} exports missing file ${exported}`);
      }
    }
  }

  const usedDependencies = new Set<string>();
  const usedExports = new Set<string>();
  const valueEdges = new Map<string, Resolution[]>();

  for (const file of files) {
    const source = classify(file);
    if (!source) {
      findings.push(`${file}: file belongs to no layer; classify it in check-import-boundaries.ts`);
      continue;
    }
    const edges: Resolution[] = [];
    let records: ImportRecord[];
    try {
      const text = readFileSync(join(root, file), "utf8");
      const loader = file.endsWith(".tsx") ? "tsx" : "ts";
      records = scanImports(text, loader);
      for (const load of computedImports(text, loader)) {
        findings.push(
          `${file}: ${load} reaches a module loader no scan can check; use a static import, or import() or require() of a string literal`,
        );
      }
    } catch (error) {
      // Fail closed: a file whose imports cannot be read could hide any of them.
      findings.push(`${file}: cannot be parsed for imports: ${parseFailure(error)}`);
      continue;
    }
    for (const record of records) {
      const resolution = resolveImport(file, record.specifier);
      if (!record.typeOnly) edges.push(resolution);
      const where = `${file}:${record.line}`;
      if (!record.typeOnly && NODE_MODULE_SPECIFIERS.has(record.specifier)) {
        findings.push(
          `${where}: imports ${record.specifier}, whose createRequire loads modules no scan can check`,
        );
        continue;
      }
      if (resolution.file === null) continue;
      if (resolution.file.startsWith("unresolved:")) {
        findings.push(`${where}: cannot resolve ${record.specifier}`);
        continue;
      }
      // A module the bundler loads but this guard never scans would hide its imports.
      if (!SOURCE_EXTENSIONS.some((extension) => resolution.file?.endsWith(extension))) {
        findings.push(`${where}: imports ${resolution.file}, which this guard does not scan`);
        continue;
      }
      const target = classify(resolution.file);
      if (!target) {
        findings.push(`${where}: imports ${resolution.file}, which is outside src/ and packages/`);
        continue;
      }
      if (!ALLOWED_LAYERS[source.layer].includes(target.layer)) {
        findings.push(
          `${where}: ${source.layer} must not import ${target.layer} (${resolution.file})`,
        );
        continue;
      }
      const crossModule =
        source.module !== undefined &&
        target.module !== undefined &&
        source.module !== target.module;
      if (!crossModule) continue;
      const declaration = modules[source.module as string];
      const targetDeclaration = modules[target.module as string];
      if (!declaration?.dependsOn.includes(target.module as string)) {
        findings.push(
          `${where}: module ${source.module} does not declare a dependency on ${target.module} (${resolution.file})`,
        );
        continue;
      }
      usedDependencies.add(`${source.module}->${target.module}`);
      if (!targetDeclaration?.exports.includes(target.modulePath as string)) {
        findings.push(
          `${where}: ${resolution.file} is internal to module ${target.module}; import one of its exports`,
        );
        continue;
      }
      usedExports.add(`${target.module}/${target.modulePath}`);
    }
    valueEdges.set(file, edges);
  }

  for (const [name, declaration] of Object.entries(modules)) {
    for (const dependency of declaration.dependsOn) {
      if (!usedDependencies.has(`${name}->${dependency}`)) {
        findings.push(`module graph: ${name} declares an unused dependency on ${dependency}`);
      }
    }
    for (const exported of declaration.exports) {
      if (!usedExports.has(`${name}/${exported}`)) {
        findings.push(`module graph: ${name} exports ${exported}, which no other module imports`);
      }
    }
  }

  const { entrypoint, declared } = workerEntrypoint(root);
  if (declared && !valueEdges.has(entrypoint)) {
    findings.push(
      `wrangler.jsonc: the Worker entry ${JSON.stringify(entrypoint)} is not a scanned source file`,
    );
  }
  // OpenNext bundles every App Router file, the middleware, and instrumentation into
  // the same Worker as its entry, which imports that bundle as generated output.
  const workerRoots = [
    ...(valueEdges.has(entrypoint) ? [entrypoint] : []),
    ...[...valueEdges.keys()].filter(isOpenNextInput).sort(),
  ];
  for (const workerRoot of workerRoots) {
    forEachReachableEdge(valueEdges, workerRoot, (edge, chain) => {
      if (edge.file === null && forbiddenInWorker(edge.packageName)) {
        findings.push(
          `${workerRoot}: the Worker bundle reaches ${edge.packageName} via ${chain.join(" -> ")}`,
        );
      }
    });
  }

  // The Edge middleware bundle must stay free of the engine and of the API layer that
  // wraps it, whose imports typecheck and build without complaint.
  if (valueEdges.has(EDGE_ENTRYPOINT)) {
    forEachReachableEdge(valueEdges, EDGE_ENTRYPOINT, (edge, chain) => {
      const reached =
        edge.file === null
          ? forbiddenInWorker(edge.packageName)
            ? edge.packageName
            : null
          : EDGE_FORBIDDEN_PREFIXES.some((prefix) => edge.file?.startsWith(prefix))
            ? edge.file
            : null;
      if (reached) {
        findings.push(
          `${EDGE_ENTRYPOINT}: the Edge middleware reaches ${reached} via ${chain.join(" -> ")}`,
        );
      }
    });
  }

  return findings;
}

function main() {
  const root = resolve(process.argv[2] ?? ".");
  const findings = checkImportBoundaries(root);
  if (findings.length) {
    console.error("Lore import-boundary guard failed:\n");
    for (const item of findings) console.error(`- ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log("Lore import-boundary guard passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

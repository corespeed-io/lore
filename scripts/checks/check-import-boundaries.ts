import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// Static import/export-from (including `import type`), side-effect imports, dynamic
// import() with a quoted or plain template specifier, and require() (including TS
// `import x = require()`). Bun.Transpiler.scanImports drops type-only imports, and a
// browser file must not reach server code even for a type.
const IMPORT_PATTERN =
  /(?:^|[\s;{}])(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"'\n]+)["']|\bimport\(\s*["']([^"'\n]+)["']\s*\)|\bimport\(\s*`([^`$\\\n]+)`\s*\)|(?<![.\w$])require\(\s*["']([^"'\n]+)["']\s*\)/g;

// A regex literal starts where an expression may: after an operator, an opening
// bracket, a separator, or a keyword that takes an expression. A `/` elsewhere is
// division, which is left in place like any other code.
const REGEX_LITERAL = String.raw`(?<=(?:^|[\n=(,:;!&|?{}[+\-*%<>~^]|\breturn|\btypeof|\bcase|\byield|\bawait|\bvoid)[ \t]*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuvy]*`;

// One left-to-right pass over comments, strings, template literals, and regex
// literals, so a `/*` or `//` inside a string, a regex, or a line comment never
// starts a comment.
const COMMENT_OR_STRING = new RegExp(
  [
    String.raw`\/\*[\s\S]*?\*\/`,
    String.raw`\/\/[^\n]*`,
    String.raw`"(?:\\.|[^"\\\n])*"`,
    String.raw`'(?:\\.|[^'\\\n])*'`,
    String.raw`\`(?:\\[\s\S]|[^\`\\])*\``,
    REGEX_LITERAL,
  ].join("|"),
  "g",
);

function stripComments(source: string): string {
  // Replace comment characters with spaces so offsets (and so line numbers) survive.
  // Strings and regex literals stay in place, so misreading one can only leave a
  // comment in place (a loud false finding), never hide an import.
  return source.replace(COMMENT_OR_STRING, (token) =>
    token.startsWith("/*") || token.startsWith("//") ? token.replace(/[^\n]/g, " ") : token,
  );
}

export function scanImports(source: string): ImportRecord[] {
  const code = stripComments(source);
  const imports: ImportRecord[] = [];
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[3] ?? match[4] ?? match[5] ?? match[6];
    if (!specifier) continue;
    const line =
      code.slice(0, match.index).split("\n").length + (match[0].startsWith("\n") ? 1 : 0);
    imports.push({ specifier, line, typeOnly: Boolean(match[2]) });
  }
  return imports;
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
    for (const record of scanImports(readFileSync(join(root, file), "utf8"))) {
      const resolution = resolveImport(file, record.specifier);
      if (!record.typeOnly) edges.push(resolution);
      const where = `${file}:${record.line}`;
      if (resolution.file === null) continue;
      if (resolution.file.startsWith("unresolved:")) {
        findings.push(`${where}: cannot resolve ${record.specifier}`);
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
    const parents = new Map<string, string>();
    const queue = [workerRoot];
    const seen = new Set(queue);
    while (queue.length) {
      const file = queue.shift() as string;
      for (const edge of valueEdges.get(file) ?? []) {
        if (edge.file === null) {
          if (forbiddenInWorker(edge.packageName)) {
            const chain = [file];
            for (let parent = parents.get(file); parent; parent = parents.get(parent))
              chain.unshift(parent);
            findings.push(
              `${workerRoot}: the Worker bundle reaches ${edge.packageName} via ${chain.join(" -> ")}`,
            );
          }
          continue;
        }
        if (seen.has(edge.file) || !valueEdges.has(edge.file)) continue;
        seen.add(edge.file);
        parents.set(edge.file, file);
        queue.push(edge.file);
      }
    }
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

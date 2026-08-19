import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PATHS = [
  "DESIGN.md",
  "src/app/globals.css",
  "src/components/App.tsx",
  "src/components/Sidebar.tsx",
  "src/components/GraphView.tsx",
  "src/components/SearchResults.tsx",
  "src/components/MemoryView.tsx",
  "src/lib/lore-api.ts",
  "src/app/[...path]/page.tsx",
  "src/app/api/graph/route.ts",
  "packages/lore-core/src/graph.ts",
];

const REQUIRED_TOKENS = [
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

const RETIRED_CLASSES = [
  "memory-rail",
  "memory-ledger",
  "ledger-heading",
  "drawer-panel",
  "scope-pill",
];

function walk(root, directory, predicate, results = []) {
  const absoluteDirectory = resolve(root, directory);
  let entries;
  try {
    entries = readdirSync(absoluteDirectory);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const absolutePath = resolve(absoluteDirectory, entry);
    const path = relative(root, absolutePath);
    if (statSync(absolutePath).isDirectory()) walk(root, path, predicate, results);
    else if (predicate(path)) results.push(path);
  }
  return results;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function finding(path, line, message) {
  return `${path}:${line} ${message}`;
}

export function checkDesignSystem(projectRoot) {
  const root = resolve(projectRoot);
  const findings = [];

  for (const path of REQUIRED_PATHS) {
    try {
      statSync(resolve(root, path));
    } catch {
      findings.push(`${path}:1 required by DESIGN.md but missing`);
    }
  }

  const stylesheets = walk(root, "src", (path) => path.endsWith(".css"));
  for (const path of stylesheets) {
    if (path !== "src/app/globals.css") {
      findings.push(`${path}:1 feature stylesheets are forbidden; use src/app/globals.css`);
    }
  }

  let stylesheet = "";
  try {
    stylesheet = readFileSync(resolve(root, "src/app/globals.css"), "utf8");
  } catch {
    // The required-path finding above is more actionable.
  }
  for (const token of REQUIRED_TOKENS) {
    if (!stylesheet.includes(`${token}:`)) {
      findings.push(
        `src/app/globals.css:1 required token ${token} is missing; register it in :root`,
      );
    }
  }

  const sources = walk(root, "src", (path) => /\.(?:ts|tsx)$/.test(path));
  for (const path of sources) {
    const source = readFileSync(resolve(root, path), "utf8");
    for (const retiredClass of RETIRED_CLASSES) {
      const match = new RegExp(`(?:className=["'][^"']*|\\.)${retiredClass}\\b`).exec(source);
      if (match) {
        findings.push(
          finding(
            path,
            lineNumber(source, match.index),
            `retired class ${retiredClass} must not return; compose the canonical Lore shell`,
          ),
        );
      }
    }
  }

  for (const retiredClass of RETIRED_CLASSES) {
    const match = new RegExp(`\\.${retiredClass}\\b`).exec(stylesheet);
    if (match) {
      findings.push(
        finding(
          "src/app/globals.css",
          lineNumber(stylesheet, match.index),
          `retired class ${retiredClass} must not return; use the active DESIGN.md vocabulary`,
        ),
      );
    }
  }

  return findings;
}

function main() {
  const root = resolve(process.argv[2] ?? ".");
  const findings = checkDesignSystem(root);
  if (findings.length) {
    console.error("Lore design-system guard failed:\n");
    for (const item of findings) console.error(`- ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log("Lore design-system guard passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

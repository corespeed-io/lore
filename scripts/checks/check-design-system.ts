import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PATHS = [
  "docs/DESIGN.md",
  "src/app/globals.css",
  "src/shell/App.tsx",
  "src/shell/Sidebar.tsx",
  "src/modules/graph/browser/GraphView.tsx",
  "src/modules/memories/browser/SearchResults.tsx",
  "src/modules/memories/browser/MemoryView.tsx",
  "src/shared/browser/sdk.ts",
  "src/app/[...path]/page.tsx",
  "src/server/api/app.ts",
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

function walk(
  root: string,
  directory: string,
  predicate: (path: string) => boolean,
  results: string[] = [],
): string[] {
  const absoluteDirectory = resolve(root, directory);
  let entries: string[];
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

function lineNumber(source: string, offset: number) {
  return source.slice(0, offset).split("\n").length;
}

function finding(path: string, line: number, message: string) {
  return `${path}:${line} ${message}`;
}

interface StringSegment {
  /** Literal text, without quotes or template `${…}` expressions. */
  text: string;
  /** Offset of `text` in the source. */
  offset: number;
}

/**
 * The text of every string and template literal in TS/TSX source, so a class
 * token is found wherever a className can be assembled: plain and braced JSX
 * attributes, template literals, ternaries, and cn()/clsx() arguments. Comments
 * are skipped, and literals nested in `${…}` are yielded on their own. Regex
 * literals and JSX text are not modeled; a stray quote there mis-scans only to
 * the end of its line, because quoted strings cannot span lines.
 */
function stringSegments(source: string): StringSegment[] {
  const segments: StringSegment[] = [];
  // Brace depth at which each open template `${` expression began.
  const templateDepths: number[] = [];
  let braceDepth = 0;
  // Scan template text from `start` to the closing backtick or the next `${`.
  const scanTemplate = (start: number): number => {
    let cursor = start;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        cursor += 2;
      } else if (char === "`") {
        segments.push({ text: source.slice(start, cursor), offset: start });
        return cursor + 1;
      } else if (char === "$" && source[cursor + 1] === "{") {
        segments.push({ text: source.slice(start, cursor), offset: start });
        templateDepths.push(braceDepth);
        braceDepth += 1;
        return cursor + 2;
      } else {
        cursor += 1;
      }
    }
    segments.push({ text: source.slice(start), offset: start });
    return source.length;
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char && source[cursor] !== "\n") {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      segments.push({ text: source.slice(index + 1, cursor), offset: index + 1 });
      index = cursor + 1;
    } else if (char === "`") {
      index = scanTemplate(index + 1);
    } else if (char === "{") {
      braceDepth += 1;
      index += 1;
    } else if (char === "}") {
      braceDepth -= 1;
      if (templateDepths.at(-1) === braceDepth) {
        templateDepths.pop();
        index = scanTemplate(index + 1);
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }
  }
  return segments;
}

/** Offset of the first whole class token (or `.token` selector) in any string literal. */
function retiredClassOffset(segments: readonly StringSegment[], retiredClass: string) {
  const token = new RegExp(`(?<![\\w-])${retiredClass}(?![\\w-])`);
  for (const segment of segments) {
    const match = token.exec(segment.text);
    if (match) return segment.offset + match.index;
  }
  return null;
}

export function checkDesignSystem(projectRoot: string) {
  const root = resolve(projectRoot);
  const findings = [];

  for (const path of REQUIRED_PATHS) {
    try {
      statSync(resolve(root, path));
    } catch {
      findings.push(`${path}:1 required by docs/DESIGN.md but missing`);
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
    const segments = stringSegments(source);
    for (const retiredClass of RETIRED_CLASSES) {
      const offset = retiredClassOffset(segments, retiredClass);
      if (offset !== null) {
        findings.push(
          finding(
            path,
            lineNumber(source, offset),
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
          `retired class ${retiredClass} must not return; use the active docs/DESIGN.md vocabulary`,
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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { sha256 } from "./hash";

/**
 * What code a checkout would run, read from the files themselves. Two checkouts
 * share a corpus or a run only when these digests match, so a change that forgot
 * to bump a revision constant still gets its own corpus and its own packets.
 */
export interface CodeIdentity {
  /** SHA-256 over every source file the entries reach, plus bun.lock and Bun's version. */
  digest: string;
  files: number;
  /** The checkout the files were read from. */
  root: string;
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/**
 * Follow every runtime import from the entries, the way Bun resolves them in this
 * checkout. Installed packages are pinned by bun.lock instead of being read. A
 * file that resolves outside the checkout is refused: it would mean a ref's
 * worktree is running another checkout's code.
 */
export function codeIdentity(entries: readonly string[], checkoutRoot: string): CodeIdentity {
  const root = realpathSync(checkoutRoot);
  const sources = new Map<string, string>();
  const pending = entries.map((entry) => realpathSync(entry));
  while (pending.length) {
    const file = pending.pop();
    if (file === undefined) break;
    const path = relative(root, file);
    if (path.startsWith("..") || isAbsolute(path)) {
      throw new Error(`${file} resolves outside ${root}; this checkout would run another's code`);
    }
    if (sources.has(path)) continue;
    const source = readFileSync(file, "utf8");
    sources.set(path, source);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const transpiler = file.endsWith("x") ? transpilers.tsx : transpilers.ts;
    for (const { path: specifier } of transpiler.scanImports(source)) {
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
      const resolved = Bun.resolveSync(specifier, dirname(file));
      // A bare builtin ("fs") resolves to itself.
      if (!isAbsolute(resolved)) continue;
      const real = realpathSync(resolved);
      if (real.split(sep).includes("node_modules")) continue;
      pending.push(real);
    }
  }
  const lock = join(root, "bun.lock");
  const parts = [...sources.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, source]) => `${path}\u0000${source}`);
  parts.push(`bun.lock\u0000${existsSync(lock) ? readFileSync(lock, "utf8") : ""}`);
  parts.push(`bun\u0000${Bun.version}`);
  return { digest: sha256(parts.join("\u0001")), files: sources.size, root };
}

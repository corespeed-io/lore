import { readFileSync, readdirSync, statSync } from "node:fs";
import { expect, test } from "vitest";

test("test runner works", () => {
  expect(1 + 1).toBe(2);
});

// NO LITERAL NUL BYTES IN SOURCE — enforced here rather than remembered.
//
// AGENTS.md has told contributors to "scan for literal NUL bytes before
// committing" ever since two were written into store.ts. The rule kept failing
// anyway, three times now, and the reason is worth stating: it depended on a
// person running a command, and the command everyone reached for
// (`grep -rlP '\x00'`) CANNOT MATCH A NUL — GNU grep's PCRE mode reads the
// subject as a C string, so the scan that was supposed to catch this returns
// clean every time. The shell one-liner is worse: `grep -q "$(printf '\000')"`
// has its NUL stripped by command substitution, leaving an empty pattern that
// matches every file in the repo.
//
// What the bytes actually cost, from the round that found them in
// tests/vault-injection-sweep.test.ts: `grep -n "etc.passwd"` on that file
// printed NOTHING although the string was there, because grep classifies a file
// containing a NUL as binary and suppresses the match. That file was the one
// testing the path-traversal defences, and it was unsearchable — which is how two
// tests that asserted nothing and a live backslash-traversal bug sat in it
// unnoticed. Git's own binary heuristic only sniffs the first 8000 bytes, so the
// diff still rendered locally while other tools disagreed; "it looked fine in the
// diff" is not evidence.
//
// A rule enforced by discipline is a rule with a path around it. This is the
// chokepoint: it reads bytes, it needs no external tool, and it runs in CI.
test("no source file contains a literal NUL byte", () => {
  const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".open-next", "dist", "coverage"]);
  // Files that are legitimately binary. Everything else is treated as source,
  // so a new text extension is covered without being added to a list.
  const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm)$/i;

  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (BINARY.test(entry)) continue;
      if (readFileSync(path).includes(0)) offenders.push(path);
    }
  };
  walk(new URL("..", import.meta.url).pathname.replace(/\/$/, ""));

  // Named, not counted: the message has to say WHICH file, because the whole
  // problem with this defect is that it makes the file hard to search.
  expect(offenders, "write \\u0000 instead of a raw NUL").toEqual([]);
});

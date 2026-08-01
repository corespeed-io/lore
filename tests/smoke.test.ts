import { readFileSync, readdirSync, statSync } from "node:fs";
import { expect, test } from "vitest";

test("test runner works", () => {
  expect(1 + 1).toBe(2);
});

// NO RAW CONTROL BYTES IN SOURCE — enforced here rather than remembered.
//
// AGENTS.md has told contributors to scan for these ever since two NULs were
// written into store.ts. The rule kept failing anyway, and the reason is the
// point: it depended on a person running a command, and every command people
// reach for is broken. `grep -qP '\x00'` DOES NOT DETECT NUL BYTES (PCRE reads
// the subject as a C string; on macOS it reported a file holding three of them
// clean). `grep -q "$(printf '\000')"` has its NUL eaten by command substitution,
// leaving an empty pattern that matches every file. And a scan built on
// `git diff --name-only` sees tracked MODIFIED files only, so a newly ADDED file
// is out of scope by construction — which is how this one arrived.
//
// What the bytes cost, from tests/vault-injection-sweep.test.ts: `grep -n
// "etc.passwd"` printed NOTHING although the string was there, and `grep -n
// '^test('` reported no tests, because grep classifies a file containing a NUL as
// binary and suppresses output. That file was the one testing the path-traversal
// defences, and it was unsearchable — which is how two tests that asserted
// nothing, a live backslash-traversal bug and two silent data corruptions sat in
// it unnoticed. Git's heuristic sniffs only the first 8000 bytes and the NULs sat
// at 8437, so the diff still rendered; "it looked fine in the diff" is not
// evidence. `file <path>` saying `data`, and `git diff --numstat` printing dashes
// instead of line counts, are the fast smell tests that do work.
//
// EVERY C0 CONTROL, not just NUL. The first version of this test checked byte 0
// only — and that same file also held a raw VT (0x0B) and a raw FF (0x0C), which
// it therefore reported clean. A check narrower than the problem is the same
// failure as a check that cannot run: it answers confidently and wrongly. Tab, LF
// and CR are the three that belong in text; everything else in 0x00-0x1F, plus
// DEL, is invisible in an editor and in a diff.
const FORBIDDEN_BYTES = [
  ...Array.from({ length: 32 }, (_, n) => n).filter((n) => n !== 0x09 && n !== 0x0a && n !== 0x0d),
  0x7f,
];

function controlBytesIn(buf: Buffer): number[] {
  return FORBIDDEN_BYTES.filter((n) => buf.includes(n));
}

// THE CHECK PROVES ITSELF, and this is the whole point of the exercise. Twice now
// a silent-failure check has cost this PR a round: `set -e` did not abort and
// printed success, and `grep -qP '\x00'` found nothing in a file full of NULs.
// Both answered confidently and wrongly. So before the scan below is believed,
// the detector is run against a buffer that is known to be bad and must catch
// every byte it claims to catch — otherwise a green run means nothing.
test("the control-byte detector actually detects", () => {
  // THE EXPECTED SET IS PINNED, not derived. Iterating FORBIDDEN_BYTES to prove
  // FORBIDDEN_BYTES works cannot catch someone NARROWING that list — delete an
  // entry and both the scanner and its proof shrink together, silently, which is
  // the exact failure this whole test exists to prevent (the first version of the
  // scanner checked byte 0 alone and reported a file holding a VT and an FF
  // clean). Written out: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F.
  expect(FORBIDDEN_BYTES).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30, 31, 127,
  ]);
  for (const n of FORBIDDEN_BYTES) {
    const planted = Buffer.concat([Buffer.from("ordinary source"), Buffer.from([n])]);
    expect(controlBytesIn(planted), `byte 0x${n.toString(16)} was not detected`).toEqual([n]);
  }
  // ...and does not fire on the three that belong in text, or on ordinary UTF-8.
  expect(controlBytesIn(Buffer.from("tab\there\r\nand a line\n// café — naïve 日本語"))).toEqual(
    [],
  );
});

test("no source file contains an invisible control byte", () => {
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
      const found = controlBytesIn(readFileSync(path));
      if (found.length) {
        offenders.push(`${path} [${found.map((n) => `0x${n.toString(16)}`).join(", ")}]`);
      }
    }
  };
  walk(new URL("..", import.meta.url).pathname.replace(/\/$/, ""));

  // Named, not counted, and the BYTE is named too: the whole problem with this
  // defect is that the file becomes hard to search, so the failure message has to
  // do the searching for you.
  expect(offenders, "write the \\uXXXX escape instead of the raw byte").toEqual([]);
});

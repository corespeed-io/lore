import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { LATEST_SCHEMA_REVISION } from "../../scripts/database/lib/migration-preflight.ts";

// AGENTS.md keeps the rules that apply to the whole project. For each area, it
// names the section of docs/agent-conventions.md that holds the details. These
// tests keep that index correct and keep AGENTS.md under the size limits.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const AGENTS = "AGENTS.md";
const CONVENTIONS = "docs/agent-conventions.md";
// Files that send a person or a tool to the agent instructions.
const POINTERS = [
  ".github/CONTRIBUTING.md",
  ".github/copilot-instructions.md",
  ".github/pull_request_template.md",
  "README.md",
  "docs/README.md",
  "docs/reference.md",
];
// Files that link to one rule in the agent instructions. They do not name both files.
const RULE_LINKS = ["docs/architecture.md"];

// Codex reads at most 32 KiB of AGENTS.md (its project_doc_max_bytes default) and
// drops the rest without a warning. Keep 2 KiB of that free. Claude Code loads
// AGENTS.md through the CLAUDE.md link and warns above 40,000 characters; a file
// under the byte limit is always under that, because a character is at least a byte.
const AGENTS_MAX_BYTES = 30 * 1024;
// Claude Code's Read tool cuts a line after 2,000 characters.
const READ_LINE_LIMIT = 2_000;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

// The headings of a Markdown file with their level. Lines in a code fence are
// not headings.
function headings(path: string): { level: number; text: string }[] {
  const found: { level: number; text: string }[] = [];
  let fenced = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6})\s+(.+?)(\s+#+)?\s*$/.exec(line);
    if (match) found.push({ level: match[1]?.length ?? 0, text: match[2] ?? "" });
  }
  return found;
}

function conventionSections(): string[] {
  return headings(join(ROOT, CONVENTIONS))
    .filter((heading) => heading.level === 2 && heading.text !== "Contents")
    .map((heading) => heading.text);
}

// The section names in the second column of the "Reference topics" table.
function topicTableSections(): string[] {
  const table = read(AGENTS).split("### Reference topics")[1]?.split("\n## ")[0] ?? "";
  return table
    .split("\n")
    .filter(
      (line) => line.startsWith("| ") && !line.startsWith("| Area |") && !line.startsWith("| ---"),
    )
    .map((line) => line.split("|")[2]?.trim() ?? "");
}

// GitHub's heading anchor: lower case, punctuation removed, spaces as hyphens.
// GitHub keeps underscores.
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

// The anchors of all headings in a Markdown file. GitHub adds "-1", "-2", and
// so on to a repeated anchor.
function headingAnchors(file: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text } of headings(file)) {
    const base = anchor(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

describe("agent instructions", () => {
  test("AGENTS.md fits in the part of the file that Codex reads", () => {
    expect(Buffer.byteLength(read(AGENTS), "utf8")).toBeLessThanOrEqual(AGENTS_MAX_BYTES);
  });

  test("no line in the instruction files is too long to read whole", () => {
    for (const path of [AGENTS, CONVENTIONS]) {
      read(path)
        .split("\n")
        .forEach((line, index) => {
          expect(line.length, `${path}:${index + 1}`).toBeLessThan(READ_LINE_LIMIT);
        });
    }
  });

  test("AGENTS.md imports no Markdown file into each session", () => {
    // Claude Code expands an "@path" outside code. An import of the reference would
    // load all of it into every session.
    const prose = read(AGENTS)
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`\n]*`/g, "");
    expect(prose).not.toMatch(/(^|\s)@[\w./-]+\.md\b/m);
  });

  test("the instruction files state the current schema revision", () => {
    for (const path of [AGENTS, CONVENTIONS]) {
      const text = read(path).replace(/\s+/g, " ");
      const stated = [
        ...text.matchAll(
          /schema_revision`? to its own (?:version )?number \(currently (\d+)\)|pin the current revision \((\d+)\)/g,
        ),
      ].map((match) => Number(match[1] ?? match[2]));
      expect(stated.length, path).toBeGreaterThan(0);
      for (const revision of stated) expect(revision, path).toBe(LATEST_SCHEMA_REVISION);
    }
  });

  test("CLAUDE.md is a link to AGENTS.md, not a copy", () => {
    expect(lstatSync(join(ROOT, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ROOT, "CLAUDE.md"))).toBe(AGENTS);
  });

  test("the topic table names each reference section once", () => {
    const named = topicTableSections();
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual([...conventionSections()].sort());
  });

  test("every reference section that AGENTS.md names exists", () => {
    const sections = conventionSections();
    // A name can wrap onto the next line, so compare with the spaces collapsed.
    const text = read(AGENTS).replace(/\s+/g, " ");
    const named = [...text.matchAll(/reference section "([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(sections, `AGENTS.md names a missing section: ${name}`).toContain(name);
    }
  });

  test("the reference contents list each section in order", () => {
    const contents = read(CONVENTIONS).split("\n## Contents\n")[1]?.split("\n## ")[0] ?? "";
    const listed = [...contents.matchAll(/^- \[(.+)\]\(#(.+)\)$/gm)].map((match) => ({
      name: match[1] ?? "",
      target: match[2] ?? "",
    }));
    expect(listed.map((entry) => entry.name)).toEqual(conventionSections());
    for (const entry of listed) expect(entry.target).toBe(anchor(entry.name));
  });

  test("each pointer file names both instruction files", () => {
    for (const path of POINTERS) {
      const text = read(path);
      expect(text, path).toContain(AGENTS);
      expect(text, path).toContain("agent-conventions.md");
    }
  });

  // A link can name a file, a heading in it ("file.md#heading"), or a heading in
  // the same file ("#heading"). Each part must exist.
  test("every relative link in the instruction files resolves", () => {
    for (const path of [AGENTS, CONVENTIONS, ...POINTERS, ...RULE_LINKS]) {
      for (const match of read(path).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1] ?? "";
        if (/^[a-z]+:/i.test(target)) continue;
        const [location = "", fragment] = target.split("#");
        const file = location === "" ? join(ROOT, path) : join(ROOT, dirname(path), location);
        expect(existsSync(file), `${path} links to a missing file: ${target}`).toBe(true);
        if (fragment === undefined || !file.endsWith(".md")) continue;
        const found = headingAnchors(file).has(fragment);
        expect(found, `${path} links to a missing heading: ${target}`).toBe(true);
      }
    }
  });
});

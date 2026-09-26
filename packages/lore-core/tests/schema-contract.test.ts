import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CORE_SCHEMA_CONTRACT } from "../src/schema-contract";

/**
 * The engine's SQL may name only what its schema contract lists, so a host can
 * learn the whole storage dependency from src/schema-contract.ts. This scans the
 * engine source for tables, `lore.*` functions, and settings, and fails on anything
 * the contract omits (and on contract entries the engine no longer uses).
 */

const SOURCE = new URL("../src/", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    // The contract and the kit that verifies it restate names on purpose.
    return path.endsWith(".ts") && !/(schema-contract|testing)\.ts$/.test(path) ? [path] : [];
  });
}

const source = sourceFiles(SOURCE)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const groups = Object.values(CORE_SCHEMA_CONTRACT);
const contractTables = new Set(groups.flatMap((group) => Object.keys(group.tables)));
const contractFunctions = new Set(
  groups.flatMap((group) => group.functions.map((signature) => signature.split("(")[0])),
);
const contractSettings = new Set(groups.flatMap((group) => [...group.settings]));

// Names the SQL defines itself: CTEs (`name AS (`, `name AS MATERIALIZED (`).
const commonTableExpressions = new Set(
  [...source.matchAll(/\b([a-z_][a-z0-9_]*)\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/g)].map(
    (match) => match[1] as string,
  ),
);

test("the engine's SQL reads and writes only contract tables", () => {
  const referenced = new Set<string>();
  for (const match of source.matchAll(
    // A name directly followed by "(" or "." is a function call or a schema.
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:public\.)?([a-z_][a-z0-9_]*)\b(?![.(])/g,
  )) {
    const name = match[1] as string;
    if (!commonTableExpressions.has(name)) referenced.add(name);
  }
  expect([...referenced].filter((name) => !contractTables.has(name)).sort()).toEqual([]);
  expect([...contractTables].filter((name) => !referenced.has(name)).sort()).toEqual([]);
});

test("the engine calls only contract functions and writes only contract settings", () => {
  const functions = new Set([...source.matchAll(/\b(lore\.[a-z_]+)\s*\(/g)].map((m) => m[1]));
  expect([...functions].filter((name) => !contractFunctions.has(name as string)).sort()).toEqual(
    [],
  );
  expect([...contractFunctions].filter((name) => !functions.has(name)).sort()).toEqual([]);

  const settings = new Set(
    [...source.matchAll(/set_config\('([a-z_.]+)'/g)].map((match) => match[1] as string),
  );
  expect([...settings].sort()).toEqual([...contractSettings].sort());
  expect(source).not.toMatch(/current_setting\(/);
});

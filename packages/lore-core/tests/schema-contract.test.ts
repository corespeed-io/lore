import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CORE_SCHEMA_CONTRACT, type TableContract } from "../src/schema-contract";

/**
 * The engine's SQL may name only what its schema contract lists, so a host can
 * learn the storage dependency from src/schema-contract.ts. This scans the engine
 * source for tables, `lore.*` functions, settings, INSERT column lists, and ON
 * CONFLICT targets, and fails on anything the contract omits and on contract
 * entries the engine no longer uses. Read-only column lists are kept by hand.
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

const sources = sourceFiles(SOURCE).map((path) => readFileSync(path, "utf8"));
const source = sources.join("\n");
const groups = Object.values(CORE_SCHEMA_CONTRACT);
const tableContracts = new Map<string, TableContract[]>();
for (const group of groups) {
  for (const [table, contract] of Object.entries(group.tables)) {
    tableContracts.set(table, [...(tableContracts.get(table) ?? []), contract]);
  }
}
const contractFunctions = new Set(
  groups.flatMap((group) => group.functions.map((signature) => signature.split("(")[0])),
);
const contractSettings = new Set(groups.flatMap((group) => [...group.settings]));

/** Table names one file's SQL references, excluding the CTEs that file defines. */
function referencedTables(text: string): string[] {
  const commonTableExpressions = new Set(
    [...text.matchAll(/\b([a-z_][a-z0-9_]*)\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/g)].map(
      (match) => match[1] as string,
    ),
  );
  const names: string[] = [];
  // INTO names a table even when its column list follows without a space; after
  // FROM, JOIN, UPDATE, or USING, a name directly followed by "(" is a function.
  for (const match of text.matchAll(/\bINTO\s+(?:public\.)?([a-z_][a-z0-9_]*)\b/g)) {
    names.push(match[1] as string);
  }
  for (const match of text.matchAll(
    /\b(?:FROM|JOIN|UPDATE|USING)\s+(?:public\.)?([a-z_][a-z0-9_]*)\b(?![.(])/g,
  )) {
    names.push(match[1] as string);
  }
  return names.filter((name) => !commonTableExpressions.has(name));
}

test("the engine's SQL reads and writes only contract tables", () => {
  const referenced = new Set(sources.flatMap(referencedTables));
  expect([...referenced].filter((name) => !tableContracts.has(name)).sort()).toEqual([]);
  expect([...tableContracts.keys()].filter((name) => !referenced.has(name)).sort()).toEqual([]);
  // Engine tables are unqualified or public; nothing lives in another schema.
  expect(source.match(/\b(?:FROM|JOIN|INTO|UPDATE)\s+lore\.[a-z_]+\b(?!\s*\()/g)).toBeNull();
});

test("INSERT column lists and ON CONFLICT targets are the contract's", () => {
  const inserted = new Map<string, Set<string>>();
  for (const match of source.matchAll(/INSERT INTO\s+([a-z_]+)\s*\(([^)]*)\)/g)) {
    const columns = inserted.get(match[1] as string) ?? new Set<string>();
    for (const column of (match[2] as string).split(",")) columns.add(column.trim());
    inserted.set(match[1] as string, columns);
  }
  for (const [table, columns] of inserted) {
    const listed = new Set((tableContracts.get(table) ?? []).flatMap((c) => c.inserts ?? []));
    expect([...columns].sort(), table).toEqual([...listed].sort());
  }
  for (const [table, contracts] of tableContracts) {
    if (contracts.some((contract) => contract.inserts))
      expect(inserted.has(table), table).toBe(true);
  }

  const conflictTargets = new Set(
    [...source.matchAll(/ON CONFLICT\s*\(([^)]*)\)/g)].map((match) =>
      (match[1] as string)
        .split(",")
        .map((column) => column.trim())
        .sort()
        .join(","),
    ),
  );
  const uniqueKeys = new Set(
    [...tableContracts.values()].flatMap((contracts) =>
      contracts.flatMap((contract) =>
        (contract.uniqueKeys ?? []).map((key) => [...key].sort().join(",")),
      ),
    ),
  );
  expect([...conflictTargets].filter((target) => !uniqueKeys.has(target)).sort()).toEqual([]);
  expect([...uniqueKeys].filter((key) => !conflictTargets.has(key)).sort()).toEqual([]);
});

test("the engine calls only contract functions and writes only contract settings", () => {
  const functions = new Set([...source.matchAll(/\b(lore\.[a-z_]+)\s*\(/g)].map((m) => m[1]));
  expect([...functions].filter((name) => !contractFunctions.has(name as string)).sort()).toEqual(
    [],
  );
  expect([...contractFunctions].filter((name) => !functions.has(name)).sort()).toEqual([]);

  // The engine writes settings through `setLocal({ "name": value })`; a literal
  // `set_config('name', …)` in SQL counts too.
  const setLocalKeys = [...source.matchAll(/setLocal\(\{([^}]*)\}\)/g)].flatMap((call) =>
    [...(call[1] ?? "").matchAll(/"([a-z_.]+)"\s*:/g)].map((match) => match[1] as string),
  );
  const settings = new Set([
    ...[...source.matchAll(/set_config\('([a-z_.]+)'/g)].map((match) => match[1] as string),
    ...setLocalKeys,
  ]);
  expect([...settings].sort()).toEqual([...contractSettings].sort());
  expect(source).not.toMatch(/current_setting\(/);
});

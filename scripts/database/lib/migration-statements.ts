// How one dbmate migration file is sent to PostgreSQL, shared by the deployment
// wrapper and every harness that replays the chain (PGlite tests, evaluation
// fixtures, the benchmark dimension tool).
//
// A transactional migration is one query: dbmate wraps it in a transaction, and a
// multi-statement simple query is one implicit transaction block anyway. A
// `-- migrate:up transaction:false` migration exists for statements such as
// CREATE INDEX CONCURRENTLY that refuse to run inside any transaction block, and
// PostgreSQL treats a multi-statement query as one. dbmate 2.35 still sends the
// whole file as a single query, so these files must be sent one statement at a time.

export interface ParsedMigration {
  /** dbmate's `transaction` option; false only for `-- migrate:up transaction:false`. */
  transaction: boolean;
  /** The up section, from its `-- migrate:up` directive line to `-- migrate:down`. */
  up: string;
}

const UP_DIRECTIVE = /^--[ \t]*migrate:up\b(.*)$/gm;
const DOWN_DIRECTIVE = /^--[ \t]*migrate:down\b.*$/gm;
// `$$` or `$tag$`: a dollar-quoted body may contain line-ending semicolons.
const DOLLAR_QUOTE = /\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/;

function isCommentOrBlank(line: string) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("--");
}

export function parseMigration(contents: string, name: string): ParsedMigration {
  const ups = [...contents.matchAll(UP_DIRECTIVE)];
  const downs = [...contents.matchAll(DOWN_DIRECTIVE)];
  const [up] = ups;
  const [down] = downs;
  if (!up || !down || ups.length !== 1 || downs.length !== 1 || down.index < up.index) {
    throw new Error(`${name} must contain one -- migrate:up directive before one -- migrate:down`);
  }
  if (!contents.slice(0, up.index).split("\n").every(isCommentOrBlank)) {
    throw new Error(`${name} has SQL before its -- migrate:up directive`);
  }
  let transaction = true;
  for (const option of (up[1] ?? "").trim().split(/\s+/).filter(Boolean)) {
    if (option === "transaction:false") transaction = false;
    else if (option !== "transaction:true") {
      throw new Error(`${name} has an unsupported migrate:up option ${option}`);
    }
  }
  return { transaction, up: contents.slice(up.index, down.index) };
}

/**
 * Splits a transaction:false up section into its statements. A statement ends
 * only at a semicolon that ends a non-comment line, so write one statement per
 * terminating line; a dollar-quoted body is rejected rather than guessed at.
 * Comment-only fragments are dropped, and trailing SQL without a terminating
 * semicolon is an error.
 */
export function splitMigrationStatements(up: string, name: string): string[] {
  if (DOLLAR_QUOTE.test(up)) {
    throw new Error(`${name} is transaction:false and must not contain a dollar-quoted body`);
  }
  const statements: string[] = [];
  let lines: string[] = [];
  let hasSql = false;
  for (const line of up.split("\n")) {
    lines.push(line);
    if (isCommentOrBlank(line)) continue;
    hasSql = true;
    if (line.trimEnd().endsWith(";")) {
      statements.push(lines.join("\n"));
      lines = [];
      hasSql = false;
    }
  }
  if (hasSql) throw new Error(`${name} ends with a statement that has no terminating semicolon`);
  return statements;
}

/** Removes comment-only and blank lines, for matching a statement's own SQL. */
export function statementSql(statement: string) {
  return statement
    .split("\n")
    .filter((line) => !isCommentOrBlank(line))
    .join("\n")
    .trim();
}

/**
 * The queries a harness sends for one migration file, in order: the whole up
 * section for a transactional migration, or each statement of a transaction:false
 * one. The deployment wrapper applies transaction:false files itself so it can
 * commit the final schema_revision UPDATE together with the ledger row.
 */
export function migrationQueries(contents: string, name: string): string[] {
  const migration = parseMigration(contents, name);
  return migration.transaction ? [migration.up] : splitMigrationStatements(migration.up, name);
}

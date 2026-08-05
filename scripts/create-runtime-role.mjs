import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const role = process.env.LORE_RUNTIME_ROLE ?? "lore_runtime";
const password = process.env.LORE_RUNTIME_PASSWORD;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!password) throw new Error("LORE_RUNTIME_PASSWORD is required");
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
  throw new Error("LORE_RUNTIME_ROLE must be a safe lowercase Postgres identifier");
}

const passwordLiteral = password.replaceAll("'", "''");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (existing.rowCount) {
    await client.query(`ALTER ROLE "${role}" LOGIN PASSWORD '${passwordLiteral}'`);
  } else {
    await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${passwordLiteral}'`);
  }
  await client.query(`GRANT lore_app TO "${role}"`);
  console.log(`configured Postgres runtime role ${role}`);
} finally {
  await client.end();
}

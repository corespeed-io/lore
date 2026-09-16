import pg from "pg";
import { runMigrationPreflight } from "./lib/migration-preflight.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const report = await runMigrationPreflight(client);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await client.end();
}

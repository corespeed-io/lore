import pg from "pg";
import { scramSha256Verifier } from "./lib/scram.ts";

const databaseUrl = process.env.DATABASE_URL;
const requestRole = process.env.LORE_RUNTIME_ROLE ?? "lore_runtime";
const requestPassword = process.env.LORE_RUNTIME_PASSWORD;
const maintenanceRole = process.env.LORE_MAINTENANCE_ROLE ?? "lore_maintenance_runtime";
const maintenancePassword = process.env.LORE_MAINTENANCE_PASSWORD;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!requestPassword) throw new Error("LORE_RUNTIME_PASSWORD is required");
if (!maintenancePassword) throw new Error("LORE_MAINTENANCE_PASSWORD is required");
if (requestRole === maintenanceRole) throw new Error("Request and maintenance roles must differ");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  async function configureLogin(
    role: string,
    password: string,
    grantedRole: "lore_app" | "lore_maintenance",
    revokedRole: "lore_app" | "lore_maintenance",
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
      throw new Error(`${role} is not a safe lowercase Postgres identifier`);
    }
    // Send only a SCRAM-SHA-256 verifier. A cleartext PASSWORD literal would
    // reach the server log (log_statement, auto_explain) and pg_stat_statements;
    // the server stores a pre-hashed verifier as given. It contains only base64,
    // `$`, and `:`, so it needs no quoting beyond the literal delimiters.
    const verifier = scramSha256Verifier(password);
    const existing = await client.query<Record<string, unknown>>(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [role],
    );
    if (existing.rowCount) {
      await client.query(
        `ALTER ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${verifier}'`,
      );
    } else {
      await client.query(
        `CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${verifier}'`,
      );
    }
    await client.query(`GRANT ${grantedRole} TO "${role}"`);
    await client.query(`REVOKE ${revokedRole} FROM "${role}"`);
    console.log(`configured Postgres runtime role ${role}`);
  }

  await configureLogin(requestRole, requestPassword, "lore_app", "lore_maintenance");
  await configureLogin(maintenanceRole, maintenancePassword, "lore_maintenance", "lore_app");
} finally {
  await client.end();
}

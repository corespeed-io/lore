import pg from "pg";

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
  async function configureLogin(role, password, grantedRole, revokedRole) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
      throw new Error(`${role} is not a safe lowercase Postgres identifier`);
    }
    const passwordLiteral = password.replaceAll("'", "''");
    const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (existing.rowCount) {
      await client.query(
        `ALTER ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${passwordLiteral}'`,
      );
    } else {
      await client.query(
        `CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${passwordLiteral}'`,
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

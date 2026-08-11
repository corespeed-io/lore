import pg from "pg";
import { migrateLoreDatabase } from "./lib/drizzle-migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await migrateLoreDatabase(client);
  console.log(
    result.adoptedLegacy ? "adopted legacy history into Drizzle" : "Drizzle migrations complete",
  );
} finally {
  await client.end();
}

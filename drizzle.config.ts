import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./db/drizzle",
  breakpoints: true,
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations",
    prefix: "index",
  },
});

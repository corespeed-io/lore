import { expect, test } from "vitest";
import { scramSha256Verifier } from "../../scripts/database/lib/scram.ts";
import { createMemoryTestContext } from "../support/memory-context";

// create-runtime-role.ts interpolates the verifier into CREATE/ALTER ROLE ... PASSWORD.
// PostgreSQL stores a string it recognizes as a SCRAM verifier unchanged; anything
// else it would hash as a cleartext password, and the runtime login would silently
// never match the operator's real password.
test("PostgreSQL stores the runtime role verifier as given instead of hashing it", async () => {
  const testContext = await createMemoryTestContext();
  const verifier = scramSha256Verifier("runtime-role-password");
  const rotated = scramSha256Verifier("rotated-role-password");

  const storedPassword = await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `CREATE ROLE "lore_scram_probe" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${verifier}'`,
    );
    const created = await transaction.query<{ rolpassword: string }>(
      "SELECT rolpassword FROM pg_authid WHERE rolname = 'lore_scram_probe'",
    );
    await transaction.query(
      `ALTER ROLE "lore_scram_probe" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${rotated}'`,
    );
    const altered = await transaction.query<{ rolpassword: string }>(
      "SELECT rolpassword FROM pg_authid WHERE rolname = 'lore_scram_probe'",
    );
    return { created: created.rows[0]?.rolpassword, altered: altered.rows[0]?.rolpassword };
  });

  expect(storedPassword).toEqual({ created: verifier, altered: rotated });
});

import { expect, test } from "vitest";
import { createMemoryTestContext } from "../support/memory-context";

// The grant matrix of the full migration chain: who may execute what in `lore`.
// Request admission runs functions as `lore_app` after a NOINHERIT login switches
// role, so the login itself must hold nothing, and the request and maintenance
// roles must each reach only their own side.

/** Functions only request transactions run (admission, identity, writes). */
const REQUEST_ONLY = [
  "lore.authenticate_agent_credential(text,uuid)",
  "lore.create_workspace(uuid,text)",
  "lore.is_active_member(uuid)",
  "lore.register_identity(uuid,uuid,text,text,text,text)",
  "lore.resolve_identity(text,text)",
];

/** Functions only the maintenance worker runs (leases, claims, generation admin). */
const MAINTENANCE_ONLY = [
  "lore.activate_embedding_generation(text,text,text)",
  "lore.claim_code_index_job(uuid,text,uuid,integer)",
  "lore.claim_memory_embedding_job(uuid,text,text,text,uuid,integer)",
  "lore.finish_memory_embedding_job(uuid,uuid,text,integer)",
  "lore.lock_current_maintenance_memory()",
  "lore.prune_retiring_embedding_generations(integer)",
  "lore.purge_expired_portable_core_records()",
];

test("every lore function is executable only by its owner, lore_app, or lore_maintenance", async () => {
  const context = await createMemoryTestContext();
  const postgres = context.postgres;
  await postgres.exec("RESET ROLE");
  const grantees = await postgres.query<{ signature: string; grantee: string }>(
    `SELECT function.oid::regprocedure::text AS signature,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee
     FROM pg_proc function
     CROSS JOIN LATERAL aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
     WHERE function.pronamespace = 'lore'::regnamespace
       AND acl.privilege_type = 'EXECUTE'
       AND acl.grantee <> function.proowner`,
  );

  expect(grantees.rows.length).toBeGreaterThan(0);
  expect(
    grantees.rows.filter((row) => !["lore_app", "lore_maintenance"].includes(row.grantee)),
  ).toEqual([]);
  await context.close();
});

test("request and maintenance roles each reach only their own functions", async () => {
  const context = await createMemoryTestContext();
  const postgres = context.postgres;
  await postgres.exec("RESET ROLE");
  const can = async (role: string, signature: string) => {
    const result = await postgres.query<{ allowed: boolean }>(
      "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS allowed",
      [role, signature],
    );
    return result.rows[0]?.allowed;
  };

  for (const signature of REQUEST_ONLY) {
    expect(await can("lore_app", signature), signature).toBe(true);
    expect(await can("lore_maintenance", signature), signature).toBe(false);
  }
  for (const signature of MAINTENANCE_ONLY) {
    expect(await can("lore_maintenance", signature), signature).toBe(true);
    expect(await can("lore_app", signature), signature).toBe(false);
  }
  await context.close();
});

test("a NOINHERIT request login holds nothing until it switches role", async () => {
  const context = await createMemoryTestContext();
  const postgres = context.postgres;
  await postgres.exec(`
    RESET ROLE;
    CREATE ROLE request_login LOGIN NOINHERIT IN ROLE lore_app;
    SET ROLE request_login;
  `);

  // Before the switch: no lore function and no tenant table.
  await expect(postgres.query("SELECT lore.current_user_id()")).rejects.toMatchObject({
    code: "42501",
  });
  await expect(postgres.query("SELECT 1 FROM memories LIMIT 1")).rejects.toMatchObject({
    code: "42501",
  });
  // After it, exactly what lore_app may do, as an admission prefix does in-transaction.
  await postgres.exec("SET ROLE lore_app");
  await expect(postgres.query("SELECT lore.current_user_id() AS id")).resolves.toMatchObject({
    rows: [{ id: null }],
  });
  await postgres.exec("RESET ROLE");
  await context.close();
});

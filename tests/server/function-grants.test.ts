import { expect, test } from "vitest";
import { createMemoryTestContext } from "../support/memory-context";

// The grant matrix of the full migration chain: who may execute what in `lore`.
// Request admission runs functions as `lore_app` after a NOINHERIT login switches
// role, so the login itself must hold nothing, and the request and maintenance
// roles must each reach only their own side.

/**
 * Every function in `lore` and the roles besides its owner that may execute it, from
 * the full migration chain. A migration that adds a function or changes a grant
 * must update this map, so the change is reviewed as a grant change. An empty list
 * means only the owner may execute it (trigger functions and internal helpers).
 */
const GRANT_MAP: Readonly<Record<string, readonly string[]>> = {
  "lore.activate_code_index_generation(uuid)": ["lore_app", "lore_maintenance"],
  "lore.activate_embedding_generation(text,text,text)": ["lore_maintenance"],
  "lore.agent_has_access(uuid,agent_grant_permission)": ["lore_app"],
  "lore.agent_owned_by_current_user(uuid)": ["lore_app"],
  "lore.append_memory_event()": [],
  "lore.append_memory_link_event()": [],
  "lore.authenticate_agent_credential(text,uuid)": ["lore_app"],
  "lore.can_append_memory_proposal_evidence(uuid,uuid)": ["lore_app"],
  "lore.can_maintain_code_index(uuid)": ["lore_maintenance"],
  "lore.can_maintain_code_index(uuid,uuid)": ["lore_maintenance"],
  "lore.can_maintain_code_index(uuid,uuid,uuid,uuid)": ["lore_maintenance"],
  "lore.can_maintain_embedding(uuid,uuid,uuid)": ["lore_maintenance"],
  "lore.can_maintain_memory(uuid,uuid)": ["lore_maintenance"],
  "lore.can_manage_evaluations(uuid,uuid)": ["lore_app"],
  "lore.can_manage_workspace(uuid)": ["lore_app"],
  "lore.can_read_code_index(uuid)": ["lore_app"],
  "lore.can_read_memory(uuid,uuid,memory_scope)": ["lore_app"],
  "lore.can_read_memory_proposal(uuid,uuid)": ["lore_app"],
  "lore.can_read_user(uuid)": ["lore_app"],
  "lore.can_read_workspace(uuid)": ["lore_app"],
  "lore.can_review_memory_proposal(uuid,uuid)": ["lore_app"],
  "lore.can_write_code_index(uuid)": ["lore_app"],
  "lore.can_write_memory(uuid,uuid)": ["lore_app"],
  "lore.cancel_agent_code_index_jobs()": [],
  "lore.cancel_superseded_code_index_jobs(text[])": ["lore_maintenance"],
  "lore.claim_code_index_job(uuid,text,uuid,integer)": ["lore_maintenance"],
  "lore.claim_memory_embedding_job(uuid,text,text,text,uuid,integer)": ["lore_maintenance"],
  "lore.clear_replay_subjects_on_reclaim()": [],
  "lore.code_index_requester_can_run(uuid,uuid,uuid)": [],
  "lore.complete_code_index_job(uuid,uuid,uuid)": ["lore_maintenance"],
  "lore.create_workspace(uuid,text)": ["lore_app"],
  "lore.current_agent_id()": ["lore_app"],
  "lore.current_code_index_job_id()": ["lore_maintenance"],
  "lore.current_code_index_lease_token()": ["lore_maintenance"],
  "lore.current_maintenance_generation_id()": ["lore_maintenance"],
  "lore.current_maintenance_job_id()": ["lore_maintenance"],
  "lore.current_maintenance_lease_token()": ["lore_maintenance"],
  "lore.current_request_id()": ["lore_app"],
  "lore.current_user_id()": ["lore_app"],
  "lore.current_workspace_id()": ["lore_app"],
  "lore.embedding_generation_report(text,text,text)": ["lore_maintenance"],
  "lore.enqueue_code_index_job(uuid,text,text,text,text)": ["lore_app"],
  "lore.enqueue_stale_memory_embedding_jobs(text,text,text,integer)": ["lore_maintenance"],
  "lore.ensure_embedding_generation(text,text,integer,text)": ["lore_app", "lore_maintenance"],
  "lore.extract_entity_aliases(text)": ["lore_app"],
  "lore.fail_code_index_job(uuid,uuid,text)": ["lore_maintenance"],
  "lore.finish_code_index_job(uuid,uuid,text,integer)": ["lore_maintenance"],
  "lore.finish_memory_embedding_job(uuid,uuid,text,integer)": ["lore_maintenance"],
  "lore.is_active_member(uuid)": ["lore_app"],
  "lore.list_pending_memory_embedding_jobs(text,text,text,integer,integer)": ["lore_maintenance"],
  "lore.list_workspaces()": ["lore_app"],
  "lore.lock_current_maintenance_memory()": ["lore_maintenance"],
  "lore.lock_reviewable_proposal_observations(uuid,uuid)": ["lore_app"],
  "lore.portable_core_capabilities()": ["lore_app", "lore_maintenance"],
  "lore.protect_memory_code_evidence_anchor()": ["lore_app"],
  "lore.protect_memory_identity()": ["lore_app"],
  "lore.protect_memory_link_identity()": ["lore_app"],
  "lore.protect_memory_proposal_review()": [],
  "lore.prune_retiring_embedding_generations(integer)": ["lore_maintenance"],
  "lore.prune_unreferenced_code_artifact_payload()": [],
  "lore.purge_expired_portable_core_records()": ["lore_maintenance"],
  "lore.ready_code_index_generation(uuid)": ["lore_app", "lore_maintenance"],
  "lore.record_episode(uuid,uuid,text,uuid,episode_kind,memory_scope,timestamp with time zone,timestamp with time zone,json)":
    ["lore_app"],
  "lore.register_identity(uuid,uuid,text,text,text,text)": ["lore_app"],
  "lore.remove_proposals_for_deleted_memory()": [],
  "lore.requeue_dead_memory_embedding_jobs(uuid,boolean)": ["lore_maintenance"],
  "lore.resolve_identity(text,text)": ["lore_app"],
  "lore.scrub_deleted_episode_replay()": [],
  "lore.scrub_deleted_memory_proposal()": [],
  "lore.scrub_replays_of_deleted_episode()": [],
  "lore.scrub_replays_of_deleted_memory()": [],
  "lore.scrub_replays_of_deleted_proposal()": [],
  "lore.submit_memory_proposal(uuid,uuid,text,uuid,memory_proposal_kind,uuid,integer,text,memory_scope,jsonb,boolean,boolean,boolean)":
    ["lore_app"],
  "lore.validate_code_dependency_edge_payload()": [],
  "lore.validate_memory_proposal_target()": [],
};

test("the grant map of every lore function is exactly the reviewed one", async () => {
  const context = await createMemoryTestContext();
  const postgres = context.postgres;
  await postgres.exec("RESET ROLE");
  const granted = await postgres.query<{ signature: string; grantees: string[] }>(
    `SELECT function.oid::regprocedure::text AS signature,
            COALESCE(
              array_agg(
                DISTINCT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END
              ) FILTER (
                WHERE acl.privilege_type = 'EXECUTE' AND acl.grantee <> function.proowner
              ),
              '{}'
            ) AS grantees
     FROM pg_proc function
     LEFT JOIN LATERAL aclexplode(
       COALESCE(function.proacl, acldefault('f', function.proowner))
     ) acl ON true
     WHERE function.pronamespace = 'lore'::regnamespace
     GROUP BY function.oid`,
  );

  // No PUBLIC anywhere, no other grantee, and each function on its reviewed side.
  expect(
    Object.fromEntries(granted.rows.map((row) => [row.signature, [...row.grantees].sort()])),
  ).toEqual(GRANT_MAP);
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

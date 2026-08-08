CREATE FUNCTION lore.claimed_memory_content(
  target_job_id uuid,
  target_lease_token uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT memory.content
  FROM memory_embedding_jobs job
  JOIN memories memory
    ON memory.workspace_id = job.workspace_id
   AND memory.id = job.memory_id
   AND memory.owner_user_id = job.owner_user_id
   AND memory.scope = job.memory_scope
   AND memory.version = job.memory_version
  WHERE job.id = target_job_id
    AND job.lease_token = target_lease_token
    AND job.status = 'processing'
$$;

CREATE POLICY memory_chunks_maintenance_insert ON memory_chunks
  FOR INSERT
  TO lore_maintenance
  WITH CHECK (lore.can_maintain_memory(workspace_id, memory_id));

CREATE POLICY memory_chunks_maintenance_delete ON memory_chunks
  FOR DELETE
  TO lore_maintenance
  USING (lore.can_maintain_memory(workspace_id, memory_id));

REVOKE ALL ON FUNCTION lore.claimed_memory_content(uuid, uuid) FROM PUBLIC;

GRANT INSERT, DELETE ON memory_chunks TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.claimed_memory_content(uuid, uuid) TO lore_maintenance;

CREATE FUNCTION lore.authenticate_agent_credential(
  candidate_secret_hash text,
  target_workspace_id uuid
)
RETURNS TABLE (user_id uuid, agent_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  UPDATE agent_credentials credential
  SET last_used_at = now()
  FROM agents agent,
       agent_workspace_grants grant_row,
       memberships owner_membership
  WHERE credential.secret_hash = candidate_secret_hash
    AND credential.revoked_at IS NULL
    AND agent.id = credential.agent_id
    AND agent.status = 'active'
    AND grant_row.agent_id = agent.id
    AND grant_row.workspace_id = target_workspace_id
    AND grant_row.status = 'active'
    AND owner_membership.workspace_id = target_workspace_id
    AND owner_membership.user_id = agent.owner_user_id
    AND owner_membership.status = 'active'
  RETURNING agent.owner_user_id, agent.id;
END
$$;

REVOKE ALL ON FUNCTION lore.authenticate_agent_credential(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.authenticate_agent_credential(text, uuid) TO lore_app;

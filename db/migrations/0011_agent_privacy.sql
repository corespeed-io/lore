DROP POLICY agents_select ON agents;
DROP POLICY agent_grants_select ON agent_workspace_grants;

CREATE POLICY agents_select ON agents
  FOR SELECT
  USING (
    owner_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
  );

CREATE POLICY agent_grants_select ON agent_workspace_grants
  FOR SELECT
  USING (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.agent_owned_by_current_user(agent_id)
  );

CREATE FUNCTION lore.can_manage_workspace(target_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT lore.current_agent_id() IS NULL
    AND target_workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM memberships
      WHERE workspace_id = target_workspace_id
        AND user_id = lore.current_user_id()
        AND status = 'active'
        AND role IN ('owner', 'admin')
    )
$$;

CREATE POLICY memberships_insert ON memberships
  FOR INSERT
  WITH CHECK (lore.can_manage_workspace(workspace_id));

CREATE POLICY memberships_update ON memberships
  FOR UPDATE
  USING (lore.can_manage_workspace(workspace_id))
  WITH CHECK (lore.can_manage_workspace(workspace_id));

CREATE POLICY memberships_delete ON memberships
  FOR DELETE
  USING (lore.can_manage_workspace(workspace_id));

GRANT INSERT, UPDATE, DELETE ON memberships TO lore_app;
GRANT EXECUTE ON FUNCTION lore.can_manage_workspace(uuid) TO lore_app;

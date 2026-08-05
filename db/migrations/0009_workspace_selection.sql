CREATE FUNCTION lore.list_workspaces()
RETURNS TABLE (
  id uuid,
  name text,
  role membership_role,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    workspace.id,
    workspace.name,
    membership.role,
    workspace.created_at,
    workspace.updated_at
  FROM memberships membership
  JOIN workspaces workspace ON workspace.id = membership.workspace_id
  WHERE membership.user_id = lore.current_user_id()
    AND membership.status = 'active'
  ORDER BY workspace.name, workspace.id
$$;

REVOKE ALL ON FUNCTION lore.list_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.list_workspaces() TO lore_app;

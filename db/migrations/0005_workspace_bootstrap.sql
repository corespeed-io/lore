CREATE FUNCTION lore.create_workspace(new_workspace_id uuid, workspace_name text)
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO workspaces (id, name)
  VALUES (new_workspace_id, workspace_name);

  INSERT INTO memberships (workspace_id, user_id, role)
  VALUES (new_workspace_id, lore.current_user_id(), 'owner');

  RETURN QUERY
  SELECT workspace.id, workspace.name, workspace.created_at, workspace.updated_at
  FROM workspaces workspace
  WHERE workspace.id = new_workspace_id;
END
$$;

REVOKE ALL ON FUNCTION lore.create_workspace(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.create_workspace(uuid, text) TO lore_app;

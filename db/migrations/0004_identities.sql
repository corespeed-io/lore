CREATE TABLE identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  subject text NOT NULL CHECK (btrim(subject) <> ''),
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

ALTER TABLE identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY identities_select ON identities
  FOR SELECT
  USING (user_id = lore.current_user_id());

CREATE FUNCTION lore.register_identity(
  new_user_id uuid,
  new_identity_id uuid,
  identity_provider text,
  identity_subject text,
  user_display_name text,
  identity_email text
)
RETURNS TABLE (
  id uuid,
  display_name text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT app_user.id, app_user.display_name, app_user.created_at, app_user.updated_at
  FROM identities identity_row
  JOIN users app_user ON app_user.id = identity_row.user_id
  WHERE identity_row.provider = identity_provider
    AND identity_row.subject = identity_subject;
  IF FOUND THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO users (id, display_name)
    VALUES (new_user_id, user_display_name);

    INSERT INTO identities (id, user_id, provider, subject, email)
    VALUES (
      new_identity_id,
      new_user_id,
      identity_provider,
      identity_subject,
      nullif(identity_email, '')
    );
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent registration won. The subtransaction rolls back both inserts;
    -- return the already-established internal User below.
  END;

  RETURN QUERY
  SELECT app_user.id, app_user.display_name, app_user.created_at, app_user.updated_at
  FROM identities identity_row
  JOIN users app_user ON app_user.id = identity_row.user_id
  WHERE identity_row.provider = identity_provider
    AND identity_row.subject = identity_subject;
END
$$;

CREATE FUNCTION lore.resolve_identity(identity_provider text, identity_subject text)
RETURNS TABLE (
  id uuid,
  display_name text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT app_user.id, app_user.display_name, app_user.created_at, app_user.updated_at
  FROM identities identity_row
  JOIN users app_user ON app_user.id = identity_row.user_id
  WHERE identity_row.provider = identity_provider
    AND identity_row.subject = identity_subject
$$;

REVOKE ALL ON FUNCTION lore.register_identity(uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.resolve_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.register_identity(uuid, uuid, text, text, text, text) TO lore_app;
GRANT EXECUTE ON FUNCTION lore.resolve_identity(text, text) TO lore_app;
GRANT SELECT (id, user_id, provider, subject, email, created_at, updated_at)
  ON identities TO lore_app;

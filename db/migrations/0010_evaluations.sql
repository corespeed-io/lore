CREATE TYPE evaluation_run_status AS ENUM ('running', 'completed', 'failed');

CREATE TABLE evaluation_suites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name, version)
);

CREATE TABLE evaluation_cases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  suite_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  query text NOT NULL CHECK (btrim(query) <> ''),
  expected_memory_ids uuid[] NOT NULL CHECK (cardinality(expected_memory_ids) > 0),
  forbidden_memory_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  result_limit integer NOT NULL DEFAULT 10 CHECK (result_limit BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, suite_id)
    REFERENCES evaluation_suites(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (suite_id, ordinal)
);

CREATE TABLE evaluation_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  suite_id uuid NOT NULL,
  status evaluation_run_status NOT NULL DEFAULT 'running',
  metrics jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, suite_id)
    REFERENCES evaluation_suites(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  )
);

CREATE TABLE evaluation_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  retrieved_memory_ids uuid[] NOT NULL,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  latency_ms double precision NOT NULL CHECK (latency_ms >= 0),
  estimated_cost_usd numeric(16, 8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES evaluation_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES evaluation_cases(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (run_id, case_id)
);

CREATE INDEX evaluation_suites_workspace_idx
  ON evaluation_suites (workspace_id, updated_at DESC, id);
CREATE INDEX evaluation_cases_suite_idx
  ON evaluation_cases (workspace_id, suite_id, ordinal, id);
CREATE INDEX evaluation_runs_suite_idx
  ON evaluation_runs (workspace_id, suite_id, started_at DESC, id);

CREATE FUNCTION lore.can_manage_evaluations(target_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND lore.is_active_member(target_workspace_id)
    AND lore.current_agent_id() IS NULL
$$;

ALTER TABLE evaluation_suites ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY evaluation_suites_all ON evaluation_suites
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id))
  WITH CHECK (
    lore.can_manage_evaluations(workspace_id)
    AND created_by_user_id = lore.current_user_id()
  );

CREATE POLICY evaluation_cases_all ON evaluation_cases
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id));

CREATE POLICY evaluation_runs_all ON evaluation_runs
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id));

CREATE POLICY evaluation_results_all ON evaluation_results
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON evaluation_suites, evaluation_cases, evaluation_runs, evaluation_results
  TO lore_app;
GRANT EXECUTE ON FUNCTION lore.can_manage_evaluations(uuid) TO lore_app;

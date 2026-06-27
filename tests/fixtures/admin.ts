// Deterministic fixtures matching upstream garrytan/gbrain admin API shapes.
// Used by admin-format tests to prove normalization handles real upstream data,
// not just empty states. No real/private data — synthetic names only.
import type {
  Agent,
  CalibrationProfile,
  RequestsPage,
  WatchSnapshot,
} from "../../src/lib/admin-format.js";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export const requestsPage: RequestsPage = {
  rows: [
    {
      id: 3,
      token_name: "gbrain-ui-ro",
      agent_name: "gbrain-ui-ro",
      operation: "search",
      latency_ms: 12,
      status: "ok",
      params: { query: "moat", limit: 5, foo: 1, bar: 2 },
      error_message: null,
      created_at: ago(90_000),
    },
    {
      id: 2,
      token_name: "garry",
      agent_name: "Garry",
      operation: "get_page",
      latency_ms: 5,
      status: "ok",
      params: { slug: "companies/acme" },
      error_message: null,
      created_at: ago(3_600_000),
    },
    {
      id: 1,
      token_name: "garry",
      agent_name: "Garry",
      operation: "put_page",
      latency_ms: 40,
      status: "error",
      params: { partial: "ac" },
      error_message: "tool 'put_page' not allowed (read-only)",
      created_at: ago(7_200_000),
    },
  ],
  total: 42,
  page: 1,
  pages: 3,
};

export const agents: Agent[] = [
  {
    id: "gbrain_cl_aaa",
    name: "gbrain-ui-ro",
    auth_type: "oauth",
    scope: "read",
    status: "active",
    requests_today: 12,
    total_requests: 353,
    last_used_at: ago(60_000),
    token_ttl: null,
    grant_types: ["client_credentials"],
  },
  {
    id: "gbrain_ak_bbb",
    name: "ci-key",
    auth_type: "api_key",
    scope: "read write",
    status: "active",
    requests_today: 0,
    total_requests: 9,
    last_used_at: null,
    token_ttl: 3600,
  },
  {
    id: "gbrain_cl_ccc",
    name: "old-client",
    auth_type: "oauth",
    scope: "read",
    status: "revoked",
    requests_today: 0,
    total_requests: 100,
    last_used_at: ago(86_400_000 * 4),
  },
];

export const jobsSnapshot: WatchSnapshot = {
  queue_health: { waiting: 0, active: 1, stalled: 2 },
  by_type: [{ name: "dream", total: 10, completed: 8, failed: 1, dead: 1 }],
  lease_pressure_1h: 7,
  top_errors: [{ message: "lease timeout", count: 3 }],
  budget_owners: [{ owner_id: 1, remaining_cents: 8000, total_spent_cents: 2000 }],
};

export const calibrationEmpty: CalibrationProfile | null = null;
export const calibrationProfile: CalibrationProfile = {
  holder: "team",
  updated_at: ago(3_600_000),
  published: true,
  brier: 0.18,
  grade_completion: 0.7,
  pattern_statements: ["overconfident on timelines"],
  voice_gate_passed: false,
  voice_gate_attempts: 2,
};

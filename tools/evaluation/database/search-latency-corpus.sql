-- A synthetic corpus for tools/evaluation/database/measure-search-latency.ts.
-- Run it as a superuser, once, on a disposable database whose name contains
-- `bench`, after `bun run db:migrate`:
--
--   psql "$BENCHMARK_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -v big=20000 -v other=10000 \
--     -f tools/evaluation/database/search-latency-corpus.sql
--
-- `big` Memories go to the measured Workspace (alice and bob are members; a quarter
-- are private) and `other` to a second one. Each Memory has 3 chunks of 120
-- Zipf-skewed pseudo-words, every tenth carries CJK text, and every chunk has a
-- random 1024-dimension vector in one active generation. 400 Episodes add 20,000
-- Observations with an evidence chunk and a vector each. Triggers are off while it
-- loads, so no embedding jobs or outbox events are written. 20,000 + 10,000 takes
-- about 30 minutes and 2 GB, most of it writing the GIN and HNSW indexes. Run
-- `VACUUM ANALYZE` afterwards.
DO $$
BEGIN
  IF current_database() !~* '(^|_)bench(mark)?($|_)' THEN
    RAISE EXCEPTION 'Refusing to seed non-benchmark database %', current_database();
  END IF;
END $$;
SET session_replication_role = replica;
INSERT INTO users (id, display_name) VALUES
 ('00000000-0000-4000-8000-0000000000a1','alice'),
 ('00000000-0000-4000-8000-0000000000b1','bob'),
 ('00000000-0000-4000-8000-0000000000c1','carol');
INSERT INTO workspaces (id, name) VALUES
 ('00000000-0000-4000-8000-000000000001','big'),
 ('00000000-0000-4000-8000-000000000002','other');
INSERT INTO memberships (workspace_id, user_id, role) VALUES
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','owner'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000b1','member'),
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000c1','owner');
INSERT INTO embedding_generations (id, embedding_provider, embedding_model, embedding_dimensions, embedding_revision, status, activated_at, validated_at)
VALUES ('00000000-0000-4000-8000-00000000e001','perf','perf-model',1024,'r1','active',now(),now());

CREATE TEMP TABLE vocab AS
SELECT i, substr(md5(i::text), 1, 3 + (i % 6)) AS w FROM generate_series(0, 4999) i;
CREATE UNIQUE INDEX ON vocab(i);

CREATE TEMP TABLE seed_mem AS
SELECT gen_random_uuid() AS id,
       CASE WHEN n <= :big THEN '00000000-0000-4000-8000-000000000001'::uuid ELSE '00000000-0000-4000-8000-000000000002'::uuid END AS ws,
       n
FROM generate_series(1, :big + :other) n;

INSERT INTO memories (id, workspace_id, owner_user_id, scope, content, title, created_at, updated_at)
SELECT m.id, m.ws,
  CASE WHEN m.ws = '00000000-0000-4000-8000-000000000002' THEN '00000000-0000-4000-8000-0000000000c1'::uuid
       WHEN m.n % 3 = 0 THEN '00000000-0000-4000-8000-0000000000b1'::uuid
       ELSE '00000000-0000-4000-8000-0000000000a1'::uuid END,
  CASE WHEN m.n % 4 = 0 THEN 'private'::memory_scope ELSE 'shared'::memory_scope END,
  'x', 'memory ' || m.n,
  now() - (m.n || ' minutes')::interval, now() - (m.n || ' minutes')::interval
FROM seed_mem m;

-- 3 chunks of about 120 Zipf-skewed words each; every 10th Memory carries CJK text.
-- The `o * 0` and `g * 0` terms tie each random draw to its row, so PostgreSQL runs
-- the subquery for every chunk and every word instead of once.
INSERT INTO memory_chunks (id, workspace_id, memory_id, ordinal, content)
SELECT gen_random_uuid(), m.ws, m.id, o,
  (SELECT string_agg(a.arr[1 + floor(4999.99 * power(random(), 3))::int + g * 0], ' ')
     FROM generate_series(1, 120) g WHERE g > o * 0 - 1)
  || CASE WHEN m.n % 10 = 0 THEN ' 数据库性能优化检索记忆' ELSE '' END
FROM seed_mem m CROSS JOIN generate_series(0, 2) o
CROSS JOIN (SELECT array_agg(w ORDER BY i) AS arr FROM vocab) a;

UPDATE memories mem SET content = c.body
FROM (SELECT memory_id, string_agg(content, ' ' ORDER BY ordinal) body FROM memory_chunks GROUP BY memory_id) c
WHERE c.memory_id = mem.id;

-- `g > c.ordinal * 0` ties the subquery to its chunk, so each chunk gets its own vector.
INSERT INTO memory_chunk_embeddings (generation_id, workspace_id, memory_id, chunk_id, embedding)
SELECT '00000000-0000-4000-8000-00000000e001', c.workspace_id, c.memory_id, c.id,
  (SELECT array_agg(random() - 0.5 + g * 0)::vector(1024) FROM generate_series(1, 1024) g WHERE g > c.ordinal * 0)
FROM memory_chunks c;
-- 400 Episodes of 50 Observations in the measured Workspace (a third of them bob's,
-- a quarter private), one evidence chunk and one vector each.
CREATE TEMP TABLE seed_ep AS
SELECT gen_random_uuid() id, n,
  CASE WHEN n % 3 = 0 THEN '00000000-0000-4000-8000-0000000000b1'::uuid ELSE '00000000-0000-4000-8000-0000000000a1'::uuid END owner,
  CASE WHEN n % 4 = 0 THEN 'private'::memory_scope ELSE 'shared'::memory_scope END scope
FROM generate_series(1, 400) n;
INSERT INTO episodes (id, workspace_id, owner_user_id, recorded_by_actor_kind, kind, scope, started_at, ended_at)
SELECT id, '00000000-0000-4000-8000-000000000001', owner, 'human', 'conversation', scope, now(), now() FROM seed_ep;
CREATE TEMP TABLE seed_obs AS
SELECT gen_random_uuid() id, e.id episode_id, o FROM seed_ep e CROSS JOIN generate_series(0, 49) o;
INSERT INTO observations (id, workspace_id, episode_id, ordinal, kind, observed_at, payload_sha256, content)
SELECT id, '00000000-0000-4000-8000-000000000001', episode_id, o, 'message', now() - (o || ' minutes')::interval, repeat('a', 64), 'observation ' || o || ' ' || md5(id::text) FROM seed_obs;
INSERT INTO episode_evidence_chunks (workspace_id, episode_id, observation_id, observation_ordinal, chunk_ordinal, content, index_revision)
SELECT '00000000-0000-4000-8000-000000000001', episode_id, id, o, 0, 'observation ' || o || ' ' || md5(id::text), 'lore-episode-evidence-v1+lore-memory-chunking-v2' FROM seed_obs;
INSERT INTO episode_evidence_chunk_embeddings (generation_id, workspace_id, episode_id, observation_id, chunk_id, embedding)
SELECT '00000000-0000-4000-8000-00000000e001', c.workspace_id, c.episode_id, c.observation_id, c.id,
  (SELECT array_agg(random() - 0.5 + g * 0)::vector(1024) FROM generate_series(1, 1024) g WHERE g > c.chunk_ordinal * 0)
FROM episode_evidence_chunks c;
RESET session_replication_role;

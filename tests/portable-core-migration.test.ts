import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, test } from "vitest";

const baseline = new URL("../db/migrations/0001_v1_baseline.sql", import.meta.url);

test("the v1 baseline installs the complete Portable Core schema", async () => {
  const postgres = new PGlite({ extensions: { pg_trgm, vector } });
  try {
    await postgres.waitReady;
    await postgres.exec(await readFile(baseline, "utf8"));

    await expect(
      postgres.query("SELECT schema_revision, api_version FROM lore_system_state WHERE singleton"),
    ).resolves.toMatchObject({ rows: [{ schema_revision: 1, api_version: "v1" }] });
    await expect(
      postgres.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'code_artifacts',
            'code_artifact_payloads',
            'code_symbol_sets',
            'code_symbol_payloads',
            'code_dependency_sets',
            'code_dependency_payloads',
            'code_dependency_edges',
            'code_index_generations',
            'code_index_jobs',
            'code_repositories',
            'code_revision_files',
            'code_revisions',
            'embedding_generations',
            'episode_evidence_chunk_embeddings',
            'episode_evidence_chunks',
            'episodes',
            'memory_proposals',
            'memory_proposal_code_evidence',
            'memory_code_evidence',
            'observations',
            'request_idempotency_records'
          )
        ORDER BY table_name
      `),
    ).resolves.toMatchObject({
      rows: [
        { table_name: "code_artifact_payloads" },
        { table_name: "code_artifacts" },
        { table_name: "code_dependency_edges" },
        { table_name: "code_dependency_payloads" },
        { table_name: "code_dependency_sets" },
        { table_name: "code_index_generations" },
        { table_name: "code_index_jobs" },
        { table_name: "code_repositories" },
        { table_name: "code_revision_files" },
        { table_name: "code_revisions" },
        { table_name: "code_symbol_payloads" },
        { table_name: "code_symbol_sets" },
        { table_name: "embedding_generations" },
        { table_name: "episode_evidence_chunk_embeddings" },
        { table_name: "episode_evidence_chunks" },
        { table_name: "episodes" },
        { table_name: "memory_code_evidence" },
        { table_name: "memory_proposal_code_evidence" },
        { table_name: "memory_proposals" },
        { table_name: "observations" },
        { table_name: "request_idempotency_records" },
      ],
    });
    await expect(
      postgres.query(`
        SELECT relname, relrowsecurity
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (
            'code_artifacts',
            'code_artifact_payloads',
            'code_symbol_sets',
            'code_symbol_payloads',
            'code_dependency_sets',
            'code_dependency_payloads',
            'code_dependency_edges',
            'code_index_generations',
            'code_index_jobs',
            'code_repositories',
            'code_revision_files',
            'code_revisions',
            'episode_evidence_chunk_embeddings',
            'episode_evidence_chunks',
            'memories',
            'memory_chunks',
            'memory_proposals',
            'memory_proposal_code_evidence',
            'memory_code_evidence',
            'observations'
          )
        ORDER BY relname
      `),
    ).resolves.toMatchObject({
      rows: [
        { relname: "code_artifact_payloads", relrowsecurity: true },
        { relname: "code_artifacts", relrowsecurity: true },
        { relname: "code_dependency_edges", relrowsecurity: true },
        { relname: "code_dependency_payloads", relrowsecurity: true },
        { relname: "code_dependency_sets", relrowsecurity: true },
        { relname: "code_index_generations", relrowsecurity: true },
        { relname: "code_index_jobs", relrowsecurity: true },
        { relname: "code_repositories", relrowsecurity: true },
        { relname: "code_revision_files", relrowsecurity: true },
        { relname: "code_revisions", relrowsecurity: true },
        { relname: "code_symbol_payloads", relrowsecurity: true },
        { relname: "code_symbol_sets", relrowsecurity: true },
        { relname: "episode_evidence_chunk_embeddings", relrowsecurity: true },
        { relname: "episode_evidence_chunks", relrowsecurity: true },
        { relname: "memories", relrowsecurity: true },
        { relname: "memory_chunks", relrowsecurity: true },
        { relname: "memory_code_evidence", relrowsecurity: true },
        { relname: "memory_proposal_code_evidence", relrowsecurity: true },
        { relname: "memory_proposals", relrowsecurity: true },
        { relname: "observations", relrowsecurity: true },
      ],
    });
    await expect(
      postgres.query(`
        SELECT extname
        FROM pg_extension
        WHERE extname IN ('pg_trgm', 'vector')
        ORDER BY extname
      `),
    ).resolves.toMatchObject({
      rows: [{ extname: "pg_trgm" }, { extname: "vector" }],
    });
    await expect(
      postgres.query(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'code_artifact_payloads_content_trgm_idx'
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          indexdef: expect.stringMatching(
            /USING gin \(lower\(content\) (?:public\.)?gin_trgm_ops\)/,
          ),
        },
      ],
    });
    await expect(
      postgres.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'code_revision_files_workspace_blob_idx'
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          indexname: "code_revision_files_workspace_blob_idx",
          indexdef: expect.stringContaining(
            "(workspace_id, object_oid, content_sha256, revision_id, path)",
          ),
        },
      ],
    });
    await expect(
      postgres.query(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'code_artifact_payloads_content_digest_check'
      `),
    ).resolves.toMatchObject({
      rows: [{ definition: expect.stringContaining("sha256(convert_to(content, 'UTF8'::name))") }],
    });
    await expect(
      postgres.query(`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname IN (
          'memories_content_check',
          'memory_chunks_content_check',
          'memory_proposals_proposed_content_check'
        )
        ORDER BY conname
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          conname: "memories_content_check",
          definition: expect.stringContaining("char_length(content) <= 32000"),
        },
        {
          conname: "memory_chunks_content_check",
          definition: expect.stringContaining("char_length(content) <= 1200"),
        },
        {
          conname: "memory_proposals_proposed_content_check",
          definition: expect.stringContaining("char_length(proposed_content) <= 32000"),
        },
      ],
    });
    await expect(
      postgres.query(`
        SELECT column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'memory_chunks'
          AND column_name = 'chunking_revision'
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          column_default: "'lore-memory-chunking-v2'::text",
          is_nullable: "NO",
        },
      ],
    });
  } finally {
    await postgres.close();
  }
});

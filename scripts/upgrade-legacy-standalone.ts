import { createHash } from "node:crypto";
import pg from "pg";
import { createAccessModule } from "../src/lib/access";
import { createPostgresDatabase } from "../src/lib/db/postgres";
import { mutationRequestHash } from "../src/lib/idempotency";
import { createIdentityModule } from "../src/lib/identity";
import { createPortabilityModule, type WorkspaceArchive } from "../src/lib/portability";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

interface LegacyPage {
  id: string;
  slug: string;
  kind: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  content_hash: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LegacyEdge {
  from_page_id: string;
  to_page_id: string;
  lane: string;
  kind: string;
  created_at: Date | string;
}

function stableUuid(label: string): string {
  const bytes = createHash("sha256")
    .update(`lore-legacy-standalone-v7:${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function legacyPageType(page: LegacyPage): string {
  const configured = page.frontmatter.type;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  if (page.kind === "memory") return "memory";
  if (page.slug.startsWith("people/")) return "person";
  if (page.slug.startsWith("companies/")) return "company";
  if (page.slug.startsWith("entities/")) return "product";
  if (page.slug.startsWith("concepts/")) return "concept";
  return "note";
}

const source = new pg.Client({ connectionString });
await source.connect();

const pages = await source.query<LegacyPage>(
  `SELECT id::text, slug, kind, title, body, frontmatter, content_hash,
          created_at, updated_at
   FROM pages
   WHERE deleted_at IS NULL
   ORDER BY id`,
);
const edges = await source.query<LegacyEdge>(
  `SELECT edge.from_page_id::text, edge.to_page_id::text,
          edge.lane, edge.kind, edge.created_at
   FROM edges edge
   JOIN pages source_page
     ON source_page.id = edge.from_page_id
    AND source_page.deleted_at IS NULL
   JOIN pages target_page
     ON target_page.id = edge.to_page_id
    AND target_page.deleted_at IS NULL
   WHERE edge.from_page_id <> edge.to_page_id
   ORDER BY edge.from_page_id, edge.to_page_id, edge.lane, edge.kind`,
);
await source.end();

if (!pages.rows.length) throw new Error("No live legacy pages found");
const pageIds = new Set(pages.rows.map((page) => page.id));
for (const edge of edges.rows) {
  if (!pageIds.has(edge.from_page_id) || !pageIds.has(edge.to_page_id)) {
    throw new Error("Legacy edge endpoint is missing from the live page set");
  }
}

const duplicateLinkKeys = new Set<string>();
for (const edge of edges.rows) {
  const key = `${edge.from_page_id}:${edge.to_page_id}:${edge.kind}`;
  if (duplicateLinkKeys.has(key)) {
    throw new Error(`Duplicate native Link key in legacy data: ${key}`);
  }
  duplicateLinkKeys.add(key);
}

const requestDatabase = createPostgresDatabase({ connectionString });
try {
  const identity = createIdentityModule(requestDatabase);
  const access = createAccessModule(requestDatabase);
  const portability = createPortabilityModule(requestDatabase);
  const user = await identity.register({
    provider: "local",
    subject: "local",
    displayName: "Local User",
    email: "local@example.com",
  });
  const workspaces = await access.listWorkspaces({ userId: user.id });
  const workspace =
    workspaces.find((candidate) => candidate.name === "Team Brain") ??
    (await access.createWorkspace({ userId: user.id }, { name: "Team Brain" }));
  const actor = { userId: user.id, workspaceId: workspace.id };

  const sourceOwnerId = stableUuid("source-owner");
  const sourceDeploymentId = stableUuid("source-deployment");
  const sourceWorkspaceId = stableUuid("source-workspace");
  const sourceMemoryIdByPageId = new Map(
    pages.rows.map((page) => [page.id, stableUuid(`page:${page.id}`)]),
  );
  const exportedAt = pages.rows.reduce(
    (latest, page) => (iso(page.updated_at) > latest ? iso(page.updated_at) : latest),
    "1970-01-01T00:00:00.000Z",
  );

  const memories = pages.rows.map((page) => ({
    id: sourceMemoryIdByPageId.get(page.id) as string,
    ownerUserId: sourceOwnerId,
    scope: "shared" as const,
    content: page.body,
    metadata: {
      title: page.title,
      type: legacyPageType(page),
      reference: page.slug,
      legacy: {
        contentHash: page.content_hash,
        frontmatter: page.frontmatter,
        pageId: page.id,
        schemaVersion: 7,
        slug: page.slug,
        system: "lore-standalone",
      },
    },
    version: 1,
    createdAt: iso(page.created_at),
    updatedAt: iso(page.updated_at),
  }));

  const links = edges.rows.map((edge) => ({
    id: stableUuid(`edge:${edge.from_page_id}:${edge.to_page_id}:${edge.lane}:${edge.kind}`),
    sourceMemoryId: sourceMemoryIdByPageId.get(edge.from_page_id) as string,
    targetMemoryId: sourceMemoryIdByPageId.get(edge.to_page_id) as string,
    kind: edge.kind,
    weight: 1,
    metadata: {
      legacy: {
        lane: edge.lane,
        system: "lore-standalone",
      },
    },
    createdAt: iso(edge.created_at),
    updatedAt: iso(edge.created_at),
  }));

  const archive: WorkspaceArchive = {
    manifest: {
      checksum: "",
      exportedAt,
      format: "lore-workspace-v1",
      memoryCount: memories.length,
      linkCount: links.length,
      sourceDeploymentId,
      sourceWorkspaceId,
      visibility: "actor-visible",
    },
    memories,
    links,
  };
  const { checksum: _checksum, ...manifest } = archive.manifest;
  archive.manifest.checksum = await mutationRequestHash({ manifest, memories, links });

  const input = {
    archive,
    conflictPolicy: "remap" as const,
    ownerMap: { [sourceOwnerId]: user.id },
  };
  const dryRun = await portability.importWorkspace(actor, { ...input, dryRun: true });
  if (dryRun.importedMemories !== pages.rows.length || dryRun.importedLinks !== edges.rows.length) {
    throw new Error(`Dry run count mismatch: ${JSON.stringify(dryRun)}`);
  }
  const imported = await portability.importWorkspace(actor, input);
  if (
    imported.importedMemories !== pages.rows.length ||
    imported.importedLinks !== edges.rows.length
  ) {
    throw new Error(`Import count mismatch: ${JSON.stringify(imported)}`);
  }

  console.log(
    JSON.stringify(
      {
        archiveChecksum: archive.manifest.checksum,
        importedLinks: imported.importedLinks,
        importedMemories: imported.importedMemories,
        legacyEdges: edges.rows.length,
        legacyPages: pages.rows.length,
        replayed: imported.replayed,
        userId: user.id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      },
      null,
      2,
    ),
  );
} finally {
  await requestDatabase.close();
}

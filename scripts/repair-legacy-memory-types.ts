import { createAccessModule } from "../src/lib/access";
import { installActorContext } from "../src/lib/actor-context";
import { createPostgresDatabase } from "../src/lib/db/postgres";
import { createIdentityModule } from "../src/lib/identity";
import { createMemoryModule } from "../src/lib/memory";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

interface ImportedMemoryRow {
  id: string;
  metadata: Record<string, unknown>;
  version: number;
}

function expectedType(metadata: Record<string, unknown>): string {
  const legacy = metadata.legacy;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return "note";
  const legacyRecord = legacy as Record<string, unknown>;
  const frontmatter = legacyRecord.frontmatter;
  if (frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
    const configured = (frontmatter as Record<string, unknown>).type;
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  }
  const slug = typeof legacyRecord.slug === "string" ? legacyRecord.slug : "";
  if (slug.startsWith("people/")) return "person";
  if (slug.startsWith("companies/")) return "company";
  if (slug.startsWith("entities/")) return "product";
  if (slug.startsWith("concepts/")) return "concept";
  return "note";
}

const database = createPostgresDatabase({ connectionString });
try {
  const identity = createIdentityModule(database);
  const access = createAccessModule(database);
  const memories = createMemoryModule(database);
  const user = await identity.register({
    provider: "local",
    subject: "local",
    displayName: "Local User",
    email: "local@example.com",
  });
  const workspace = (await access.listWorkspaces({ userId: user.id })).find(
    (candidate) => candidate.name === "Team Brain",
  );
  if (!workspace) throw new Error("Team Brain Workspace was not found");
  const actor = { userId: user.id, workspaceId: workspace.id };
  const imported = await database.transaction(async (transaction) => {
    await installActorContext(transaction, actor);
    const result = await transaction.query<ImportedMemoryRow>(
      `SELECT id, metadata, version
       FROM memories
       WHERE workspace_id = $1
         AND metadata @> '{"legacy":{"system":"lore-standalone"}}'::jsonb
       ORDER BY id`,
      [workspace.id],
    );
    return result.rows;
  });

  const repairedByType = new Map<string, number>();
  let repaired = 0;
  for (const memory of imported) {
    const type = expectedType(memory.metadata);
    repairedByType.set(type, (repairedByType.get(type) ?? 0) + 1);
    if (memory.metadata.type === type) continue;
    const updated = await memories.update(
      actor,
      memory.id,
      { metadata: { ...memory.metadata, type } },
      { expectedVersion: memory.version },
    );
    if (!updated) throw new Error(`Memory ${memory.id} disappeared during repair`);
    repaired += 1;
  }

  console.log(
    JSON.stringify(
      {
        importedMemories: imported.length,
        repaired,
        types: Object.fromEntries(
          [...repairedByType].sort(([left], [right]) => left.localeCompare(right)),
        ),
        workspaceId: workspace.id,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}

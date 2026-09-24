import { createMemoryMaintenanceModule } from "@corespeed/lore-core";
import { createPostgresDatabase } from "../../src/server/database/postgres";
import {
  embeddingBuildEnvironment,
  embeddingConfigurationFromEnvironment,
} from "../../src/server/providers/embedding/config";

// Operator commands for embedding generations, run with the maintenance login:
//   report                          read-only coverage of the configured generation
//   activate                        atomically activate the configured generation
//   requeue-dead --generation <id>  count dead jobs of one generation (dry run)
//   requeue-dead --generation <id> --apply
//                                   re-arm them as pending with a fresh retry budget
const usage =
  "Usage: embedding-generation.ts report | activate | requeue-dead --generation <uuid> [--apply]";

const connectionString = process.env.LORE_MAINTENANCE_DATABASE_URL;
if (!connectionString) throw new Error("LORE_MAINTENANCE_DATABASE_URL is required");

const [command = "report", ...options] = process.argv.slice(2);

function generationSelector(): string {
  const flag = options.indexOf("--generation");
  const value = flag >= 0 ? options[flag + 1]?.trim().toLowerCase() : undefined;
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(
      `requeue-dead requires --generation <uuid>; take the id from db:embedding:report. ${usage}`,
    );
  }
  return value;
}

function configuredMaintenance(database: ReturnType<typeof createPostgresDatabase>) {
  const buildEnvironment = embeddingBuildEnvironment(process.env) ?? process.env;
  const configuration = embeddingConfigurationFromEnvironment(buildEnvironment);
  const provider = {
    ...configuration,
    async embed(): Promise<number[][]> {
      throw new Error("Generation administration does not call the embedding provider");
    },
  };
  return createMemoryMaintenanceModule(database, { embeddingProvider: provider });
}

if (!["report", "activate", "requeue-dead"].includes(command)) throw new Error(usage);
const database = createPostgresDatabase({ connectionString }, { role: "lore_maintenance" });
try {
  if (command === "report") {
    // Read-only: reporting must never create a generation or seed jobs.
    const maintenance = configuredMaintenance(database);
    const report = await maintenance.findGenerationReport();
    console.log(
      JSON.stringify(
        report ?? {
          status: "not initialized",
          detail:
            "No generation exists for this provider/model/revision yet; the maintenance worker creates it on its next sweep",
        },
        null,
        2,
      ),
    );
  } else if (command === "activate") {
    const id = await configuredMaintenance(database).activateGeneration();
    console.log(JSON.stringify({ status: "active", generationId: id }));
  } else {
    const generationId = generationSelector();
    const apply = options.includes("--apply");
    const count = await database.transaction(async (transaction) => {
      const result = await transaction.query<{ count: string | number }>(
        "SELECT lore.requeue_dead_memory_embedding_jobs($1, $2) AS count",
        [generationId, apply],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    console.log(
      JSON.stringify(
        apply
          ? { status: "requeued", generationId, requeuedJobs: count }
          : {
              status: "dry run",
              generationId,
              deadJobs: count,
              detail: "Re-run with --apply to re-arm these jobs as pending",
            },
      ),
    );
  }
} finally {
  await database.close();
}

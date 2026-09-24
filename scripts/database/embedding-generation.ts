import { createMemoryMaintenanceModule } from "@corespeed/lore-core";
import { createPostgresDatabase } from "../../src/server/database/postgres";
import {
  type EmbeddingConfiguration,
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

export interface AdministeredGeneration extends EmbeddingConfiguration {
  /** The variable pair that named this generation. */
  source: "LORE_EMBEDDING_BUILD_PROVIDER/MODEL" | "LORE_EMBEDDING_PROVIDER/MODEL";
}

/**
 * The generation `report` and `activate` act on. These commands run with
 * `--no-env-file`, so an identity is never taken from a default: falling back to
 * the default Ollama model could activate, and so roll serving back to, a
 * generation the operator never named. The build pair wins over the serving pair,
 * as it does on the maintenance worker.
 */
export function administeredGeneration(
  env: Record<string, string | undefined>,
): AdministeredGeneration {
  const build = embeddingBuildEnvironment(env);
  if (build) {
    return {
      ...embeddingConfigurationFromEnvironment(build),
      source: "LORE_EMBEDDING_BUILD_PROVIDER/MODEL",
    };
  }
  if (!env.LORE_EMBEDDING_PROVIDER?.trim() || !env.LORE_EMBEDDING_MODEL?.trim()) {
    throw new Error(
      "Name the embedding generation explicitly: set LORE_EMBEDDING_BUILD_PROVIDER and " +
        "LORE_EMBEDDING_BUILD_MODEL for a build target, or LORE_EMBEDDING_PROVIDER and " +
        "LORE_EMBEDDING_MODEL for the serving generation. db:embedding:* commands run " +
        "with --no-env-file and never fall back to a default model.",
    );
  }
  return { ...embeddingConfigurationFromEnvironment(env), source: "LORE_EMBEDDING_PROVIDER/MODEL" };
}

function generationSelector(options: readonly string[]): string {
  const flag = options.indexOf("--generation");
  const value = flag >= 0 ? options[flag + 1]?.trim().toLowerCase() : undefined;
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(
      `requeue-dead requires --generation <uuid>; take the id from db:embedding:report. ${usage}`,
    );
  }
  return value;
}

function administeredMaintenance(
  database: ReturnType<typeof createPostgresDatabase>,
  generation: AdministeredGeneration,
) {
  const { source: _source, ...configuration } = generation;
  const provider = {
    ...configuration,
    async embed(): Promise<number[][]> {
      throw new Error("Generation administration does not call the embedding provider");
    },
  };
  return createMemoryMaintenanceModule(database, { embeddingProvider: provider });
}

async function runEmbeddingGenerationCommand(argv: readonly string[]): Promise<void> {
  const [command = "report", ...options] = argv;
  if (!["report", "activate", "requeue-dead"].includes(command)) throw new Error(usage);
  const connectionString = process.env.LORE_MAINTENANCE_DATABASE_URL;
  if (!connectionString) throw new Error("LORE_MAINTENANCE_DATABASE_URL is required");
  // Resolve the identity before connecting, so a missing one fails without touching
  // the database.
  const generation = command === "requeue-dead" ? null : administeredGeneration(process.env);
  const database = createPostgresDatabase({ connectionString }, { role: "lore_maintenance" });
  try {
    if (generation) {
      const identity = {
        provider: generation.provider,
        model: generation.model,
        dimensions: generation.dimensions,
        revision: generation.revision,
        source: generation.source,
      };
      const maintenance = administeredMaintenance(database, generation);
      if (command === "report") {
        // Read-only: reporting must never create a generation or seed jobs.
        const report = await maintenance.findGenerationReport();
        console.log(
          JSON.stringify(
            {
              generation: identity,
              ...(report ?? {
                status: "not initialized",
                detail:
                  "No generation exists for this provider/model/revision yet; the maintenance worker creates it on its next sweep",
              }),
            },
            null,
            2,
          ),
        );
      } else {
        const id = await maintenance.activateGeneration();
        console.log(JSON.stringify({ status: "active", generationId: id, generation: identity }));
      }
    } else {
      const generationId = generationSelector(options);
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
}

if (import.meta.main) await runEmbeddingGenerationCommand(process.argv.slice(2));

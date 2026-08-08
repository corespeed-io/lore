import { createPostgresDatabase } from "../src/lib/db/postgres";
import { embeddingConfigurationFromEnvironment } from "../src/lib/embedding-config";
import { createMemoryMaintenanceModule } from "../src/lib/maintenance";

const connectionString = process.env.LORE_MAINTENANCE_DATABASE_URL;
if (!connectionString) throw new Error("LORE_MAINTENANCE_DATABASE_URL is required");

const buildEnvironment = {
  ...process.env,
  LORE_EMBEDDING_PROVIDER:
    process.env.LORE_EMBEDDING_BUILD_PROVIDER ?? process.env.LORE_EMBEDDING_PROVIDER,
  LORE_EMBEDDING_MODEL: process.env.LORE_EMBEDDING_BUILD_MODEL ?? process.env.LORE_EMBEDDING_MODEL,
};
const configuration = embeddingConfigurationFromEnvironment(buildEnvironment);
const provider = {
  ...configuration,
  async embed(): Promise<number[][]> {
    throw new Error("Generation administration does not call the embedding provider");
  },
};
const database = createPostgresDatabase({ connectionString }, { role: "lore_maintenance" });
try {
  const maintenance = createMemoryMaintenanceModule(database, { embeddingProvider: provider });
  const command = process.argv[2] ?? "report";
  if (command === "report") {
    await maintenance.seedStale(1);
    console.log(JSON.stringify(await maintenance.generationReport(), null, 2));
  } else if (command === "activate") {
    const id = await maintenance.activateGeneration();
    console.log(JSON.stringify({ status: "active", generationId: id }));
  } else {
    throw new Error("Command must be report or activate");
  }
} finally {
  await database.close();
}

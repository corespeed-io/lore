export const BASELINE_MIGRATION_ID = "0001_initial.sql";

export const LEGACY_BASELINE_MIGRATIONS = new Map([
  ["0001_memory.sql", "cad2fd73c45112ac5363d3d623d05247f679756002dd4dc7fae9c8a4aed5a396"],
  ["0002_agents.sql", "5d308521092f29ec3d63c011de7b4928175b6fdb5f9a2e28e7a632504b9b0283"],
  [
    "0003_agent_authentication.sql",
    "606d33d2e0cc2ee3e13d2ca16aef0608ebf79e860999d4c1799c1677c412727a",
  ],
  ["0004_identities.sql", "9b81f1531758a86297b38ef8935b5d4f4c90e2538a76328f8253a208e32213f6"],
  [
    "0005_workspace_bootstrap.sql",
    "dd0c6a1f6cc4b9655b0d240e0855fbd75b1a90c6bd3c029bc8326b07bb344938",
  ],
  [
    "0006_membership_management.sql",
    "cb9602ea3691c83b12ba7985cc8a242c755c4d3a439066b3b32e72faa2307927",
  ],
  ["0007_memory_chunks.sql", "9c745a2c254507d1fa332b463050877d7b1c80d857ad8ead039cb61bcc6fe01d"],
  ["0008_vector_search.sql", "5377b6cbccde6c9ad0b574cc3ee54247f14ce9712cc53ad3197c763c3e5149f7"],
  [
    "0009_workspace_selection.sql",
    "2fe8b7a208c8130cc017faec0c40482f85b2c6412b5205121c923b30d2623e5b",
  ],
  ["0010_evaluations.sql", "26399a72f5ad8fe657498e8c26746077500d21d6f1cdc8d53cc4d3954d857448"],
  ["0011_agent_privacy.sql", "890b5c261dd48d4a4ea5b26449b175842bda7815c02f169be9c4e0796a391863"],
  ["0012_memory_links.sql", "bd49e73177f88c610d293de9cc64f7f4c5bce374b8011898c5f91dd1d55b6ee0"],
  [
    "0013_deployment_embedding_config.sql",
    "7ba65883ae273cfa936fae956c57b602db61fa996258e03a9490edef247ed00b",
  ],
]);

export function hasCompleteLegacyBaseline(appliedMigrations) {
  const legacyRows = appliedMigrations.filter(({ id }) => LEGACY_BASELINE_MIGRATIONS.has(id));
  if (legacyRows.length === 0) return false;

  if (legacyRows.length !== LEGACY_BASELINE_MIGRATIONS.size) {
    throw new Error(
      `Cannot adopt squashed migration baseline: found ${legacyRows.length} of ${LEGACY_BASELINE_MIGRATIONS.size} legacy migrations`,
    );
  }

  for (const { id, checksum } of legacyRows) {
    if (LEGACY_BASELINE_MIGRATIONS.get(id) !== checksum) {
      throw new Error(
        `Cannot adopt squashed migration baseline: legacy migration ${id} was modified`,
      );
    }
  }

  return true;
}

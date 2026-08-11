export const DBMATE_MIGRATIONS_TABLE = "lore_schema_migrations";

/**
 * Checksums written by Lore's pre-dbmate runner. The SQL remains equivalent after
 * adding dbmate's comment directives, so an exact prefix can be adopted without
 * replaying DDL or touching tenant data.
 */
export const PRE_DBMATE_MIGRATIONS = new Map([
  ["0001_initial.sql", "79e160c1cd812f973baacb1d4bb10d9f10ee495fdcb73a64f0581cb0f14d5a40"],
  [
    "0002_memory_embedding_jobs.sql",
    "e1075a30e35e5d18f3c28c12f8366b42bf62481a0dd196995b23794ee1a038b5",
  ],
  ["0003_portable_core.sql", "4ba5ae39c9771fce5d2f16371974c140160e68e7a89e190f751153bc7651704b"],
  [
    "0004_english_lexical_search.sql",
    "edb1be778f9a19bbe4d0bba96360f344d2cdbdcb19d4face56ef684aa4ae5f7f",
  ],
  [
    "0005_memory_metadata_search.sql",
    "1e4efdc91f03e7922bfd16a9d6fbec0f6e49f80cf9b9d36a2ec66d64fa145d89",
  ],
  [
    "0006_memory_chunk_entity_aliases.sql",
    "66821ec21a99a91c6e6f89ede1985c737216d567b38dc70c5edcc45e827bfdf1",
  ],
  ["0007_agent_lifecycle.sql", "bd677a854281d84f55115b3f4b2fdf9d5d6a62f0d3f1d7266e870b83c4f62cec"],
  ["0008_memory_proposals.sql", "85f72f4b125a525369bbd274f3ee023d0688b8a36ecfa1947d53718280155036"],
  [
    "0009_observation_evidence.sql",
    "706f27c235b8040a406a49174c84cfc7986d22e36d3a751641e44528b825c627",
  ],
]);

/** The original 13-file history already represented by 0001_initial.sql. */
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

function exactHistory(rows, expected, label) {
  if (rows.length !== expected.size) {
    throw new Error(`Cannot adopt ${label}: found ${rows.length} of ${expected.size} migrations`);
  }
  for (const { id, checksum } of rows) {
    const expectedChecksum = expected.get(id);
    if (!expectedChecksum) throw new Error(`Cannot adopt ${label}: unknown migration ${id}`);
    if (expectedChecksum !== checksum) {
      throw new Error(`Cannot adopt ${label}: migration ${id} was modified`);
    }
  }
}

export function hasCompleteLegacyBaseline(rows) {
  if (!rows.some(({ id }) => LEGACY_BASELINE_MIGRATIONS.has(id))) return false;
  exactHistory(rows, LEGACY_BASELINE_MIGRATIONS, "legacy baseline");
  return true;
}

export function preDbmateAdoption(rows) {
  if (rows.length === 0) return { kind: "empty", versions: [] };
  if (rows.some(({ id }) => LEGACY_BASELINE_MIGRATIONS.has(id))) {
    exactHistory(rows, LEGACY_BASELINE_MIGRATIONS, "legacy baseline");
    return { kind: "legacy-baseline", versions: ["0001"] };
  }

  const expectedEntries = [...PRE_DBMATE_MIGRATIONS];
  const applied = new Set();
  for (const { id, checksum } of rows) {
    const expectedChecksum = PRE_DBMATE_MIGRATIONS.get(id);
    if (!expectedChecksum)
      throw new Error(`Cannot adopt pre-dbmate history: unknown migration ${id}`);
    if (expectedChecksum !== checksum) {
      throw new Error(`Cannot adopt pre-dbmate history: migration ${id} was modified`);
    }
    applied.add(id);
  }
  const highestApplied = expectedEntries.reduce(
    (highest, [id], index) => (applied.has(id) ? index : highest),
    -1,
  );
  const missing = expectedEntries
    .slice(0, highestApplied + 1)
    .map(([id]) => id)
    .filter((id) => !applied.has(id));
  if (missing.length > 0) {
    throw new Error(`Cannot adopt pre-dbmate history: missing migration ${missing.join(", ")}`);
  }
  return {
    kind: "pre-dbmate",
    versions: expectedEntries.slice(0, highestApplied + 1).map(([id]) => /^([0-9]+)/.exec(id)?.[1]),
  };
}

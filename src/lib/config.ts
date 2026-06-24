export interface Config {
  gbrainMcpUrl: string;
  gbrainToken: string;
  seedQueries: string[];
  appTitle: string;
  brandColors: Record<string, string>;
  authMode: "none" | "password" | "proxy";
  uiPassword: string;
  accessTeamDomain: string;
  accessAud: string;
}

const DEFAULT_SEEDS = [
  "overview getting started",
  "architecture design decisions",
  "people team roles",
  "projects products",
];

const DEFAULT_COLORS = {
  person: "#7F77DD",
  company: "#D85A30",
  product: "#1D9E75",
  concept: "#888780",
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const seeds = (env.SEED_QUERIES ?? "")
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = env.AUTH_MODE;
  return {
    gbrainMcpUrl: env.GBRAIN_MCP_URL ?? "",
    gbrainToken: env.GBRAIN_TOKEN ?? "",
    seedQueries: seeds.length ? seeds : DEFAULT_SEEDS,
    appTitle: env.APP_TITLE ?? "gbrain",
    brandColors: env.BRAND_COLORS ? JSON.parse(env.BRAND_COLORS) : DEFAULT_COLORS,
    authMode: mode === "password" || mode === "proxy" ? mode : "none",
    uiPassword: env.UI_PASSWORD ?? "",
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    accessAud: env.ACCESS_AUD ?? "",
  };
}

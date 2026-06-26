// EDGE-RUNTIME MODULE. loadConfig() runs inside middleware (via auth.ts) on the
// Edge runtime — keep this file free of Node-only APIs (Buffer, node:*, fs).
export interface Config {
  gbrainMcpUrl: string;
  gbrainToken: string;
  // Preferred over gbrainToken: an OAuth2 client_credentials client (ideally
  // read-only). When set, the server mints short-lived access tokens instead of
  // sending a long-lived static bearer.
  gbrainClientId: string;
  gbrainClientSecret: string;
  gbrainTokenUrl: string;
  // How to present client creds at the token endpoint, and an optional requested
  // scope — so any gbrain OAuth client (post/basic, narrowed scope) can be used.
  gbrainTokenAuthMethod: "post" | "basic";
  gbrainScope: string;
  seedQueries: string[];
  appTitle: string;
  appSubtitle: string;
  authMode: "none" | "password" | "proxy";
  uiPassword: string;
  accessTeamDomain: string;
  accessAud: string;
  // "none" auth is fail-open. Require explicit opt-in so a deploy that forgets
  // to set AUTH_MODE doesn't silently serve a private brain to the internet.
  allowInsecure: boolean;
}

const DEFAULT_SEEDS = [
  "overview getting started",
  "architecture design decisions",
  "people team roles",
  "projects products",
];

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
    gbrainClientId: env.GBRAIN_CLIENT_ID ?? "",
    gbrainClientSecret: env.GBRAIN_CLIENT_SECRET ?? "",
    gbrainTokenUrl: env.GBRAIN_TOKEN_URL ?? "",
    gbrainTokenAuthMethod: env.GBRAIN_TOKEN_AUTH_METHOD === "basic" ? "basic" : "post",
    gbrainScope: env.GBRAIN_SCOPE ?? "",
    seedQueries: seeds.length ? seeds : DEFAULT_SEEDS,
    appTitle: env.APP_TITLE ?? "gbrain",
    appSubtitle: env.APP_SUBTITLE ?? "A searchable knowledge graph of your team's memory.",
    authMode: mode === "password" || mode === "proxy" ? mode : "none",
    uiPassword: env.UI_PASSWORD ?? "",
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    accessAud: env.ACCESS_AUD ?? "",
    allowInsecure: env.ALLOW_INSECURE === "1" || env.ALLOW_INSECURE === "true",
  };
}

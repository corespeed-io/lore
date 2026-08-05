// EDGE-RUNTIME MODULE. loadConfig() runs inside middleware (via auth.ts) on the
// Edge runtime — keep this file free of Node-only APIs (Buffer, node:*, fs).
export interface Config {
  appTitle: string;
  appSubtitle: string;
  authMode: "none" | "password" | "proxy";
  uiPassword: string;
  accessTeamDomain: string;
  accessAud: string;
  localSubject: string;
  localDisplayName: string;
  localEmail: string;
  // "none" disables external authentication. Require explicit opt-in so a
  // deploy that forgets AUTH_MODE cannot expose private Memory to the internet.
  allowInsecure: boolean;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const mode = env.AUTH_MODE;
  return {
    appTitle: env.APP_TITLE ?? "Memory for humans and agents",
    appSubtitle:
      env.APP_SUBTITLE ??
      "Store, isolate, and retrieve durable memory across users, workspaces, and agents.",
    authMode: mode === "password" || mode === "proxy" ? mode : "none",
    uiPassword: env.UI_PASSWORD ?? "",
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    accessAud: env.ACCESS_AUD ?? "",
    localSubject: env.LORE_LOCAL_SUBJECT ?? "local",
    localDisplayName: env.LORE_LOCAL_DISPLAY_NAME ?? "Local User",
    localEmail: env.LORE_LOCAL_EMAIL ?? "",
    allowInsecure: env.ALLOW_INSECURE === "1" || env.ALLOW_INSECURE === "true",
  };
}

import { loadConfig } from "./config.js";

export function checkAuth(
  headers: Headers,
  cookies: { get(n: string): { value: string } | undefined },
): { ok: boolean; status?: number; wwwAuthenticate?: boolean } {
  const cfg = loadConfig();
  if (cfg.authMode === "proxy" && cfg.accessAud && cfg.accessTeamDomain) {
    const tok = headers.get("cf-access-jwt-assertion") || cookies.get("CF_Authorization")?.value;
    return tok ? { ok: true } : { ok: false, status: 403 };
  }
  if (cfg.authMode === "password" && cfg.uiPassword) {
    const h = headers.get("authorization") ?? "";
    if (h.startsWith("Basic ")) {
      const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === cfg.uiPassword) return { ok: true };
    }
    return { ok: false, status: 401, wwwAuthenticate: true };
  }
  return { ok: true };
}

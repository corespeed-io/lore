// Next runs register() once at server startup. We only WARN (never throw) so a
// misconfigured deploy still passes the platform healthcheck and surfaces the
// problem in the logs immediately, instead of failing opaquely per-request.
export function register() {
  const missing: string[] = [];
  if (!process.env.GBRAIN_MCP_URL) missing.push("GBRAIN_MCP_URL");
  // Credentials: either a static GBRAIN_TOKEN, or a full OAuth client pair.
  const hasToken = Boolean(process.env.GBRAIN_TOKEN);
  const hasOAuth = Boolean(process.env.GBRAIN_CLIENT_ID && process.env.GBRAIN_CLIENT_SECRET);
  if (!hasToken && !hasOAuth)
    missing.push("GBRAIN_TOKEN (or GBRAIN_CLIENT_ID + GBRAIN_CLIENT_SECRET)");
  if (missing.length)
    console.warn(
      `[lore] missing required config: ${missing.join(", ")} — gbrain calls will fail until these are set`,
    );
}

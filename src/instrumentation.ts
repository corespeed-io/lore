export async function register(): Promise<void> {
  // @vercel/otel installs a Node SDK and imports node:process. OpenNext executes
  // this hook inside workerd's Node compatibility layer, where that module is
  // intentionally unavailable. Cloudflare deployments use Wrangler's native
  // observability; Node/self-host loads the privacy-filtered OTLP SDK lazily.
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") return;
  const { registerLoreTelemetry } = await import("./lib/register-telemetry");
  registerLoreTelemetry();
}

import { loadConfig } from "@/server/config";
import { App } from "@/shell/App";

// Branding and auth-adjacent deployment values are runtime configuration. Do
// not bake a developer's ignored .env into a Cloudflare or Docker artifact.
export const dynamic = "force-dynamic";

export default function Page() {
  const { appTitle, appSubtitle } = loadConfig();
  return <App appTitle={appTitle} appSubtitle={appSubtitle} />;
}

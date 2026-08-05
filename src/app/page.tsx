import { MemoryConsole } from "@/components/memory-console";
import { loadConfig } from "@/lib/config";

// Branding and auth-adjacent deployment values are runtime configuration. Do
// not bake a developer's ignored .env into a Cloudflare or Docker artifact.
export const dynamic = "force-dynamic";

export default function Page() {
  const { appTitle, appSubtitle } = loadConfig();
  return <MemoryConsole appTitle={appTitle} appSubtitle={appSubtitle} />;
}

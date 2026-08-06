import { App } from "@/components/App";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function Page() {
  const { appTitle, appSubtitle } = loadConfig();
  return <App appTitle={appTitle} appSubtitle={appSubtitle} />;
}

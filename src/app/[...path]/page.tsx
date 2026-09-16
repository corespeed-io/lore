import { loadConfig } from "@/server/config";
import { App } from "@/shell/App";

export const dynamic = "force-dynamic";

export default function Page() {
  const { appTitle, appSubtitle } = loadConfig();
  return <App appTitle={appTitle} appSubtitle={appSubtitle} />;
}

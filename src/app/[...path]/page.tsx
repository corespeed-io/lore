import { App } from "@/components/App";
import { loadConfig } from "@/lib/config";

export default function Page() {
  const { appTitle, appSubtitle, brandColors } = loadConfig();
  return <App appTitle={appTitle} appSubtitle={appSubtitle} brandColors={brandColors} />;
}

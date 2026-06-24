import { App } from "@/components/App";
import { loadConfig } from "@/lib/config";

export default function Page() {
  const { appTitle, brandColors } = loadConfig();
  return <App appTitle={appTitle} brandColors={brandColors} />;
}

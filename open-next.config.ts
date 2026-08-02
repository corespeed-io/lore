// Cloudflare Workers build config (npm run cf:build). Defaults are right for
// lore: no ISR/cache bindings needed — the app is dynamic API routes + one page.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();

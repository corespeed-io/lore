import { LoreClient } from "@corespeed/lore-sdk";
import { recordRequest } from "./request-log";

/** Resolve browser context only when a hook starts a request, never during SSR. */
export function getBrowserClient(): LoreClient {
  return new LoreClient({
    baseUrl: window.location.origin,
    credentials: "same-origin",
    timeoutMs: null,
    onRequest: recordRequest,
  });
}

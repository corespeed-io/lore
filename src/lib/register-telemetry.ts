import { registerOTel } from "@vercel/otel";
import { PrivacySpanProcessor } from "./telemetry-privacy";

export function registerLoreTelemetry(): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    return;
  }
  registerOTel({
    serviceName: "lore",
    spanProcessors: [new PrivacySpanProcessor(), "auto"],
    instrumentationConfig: {
      fetch: {
        // Provider URLs and query strings may carry operator-controlled data.
        // Lore emits explicit bounded spans instead of copying outbound URLs.
        ignoreUrls: [/.*/],
      },
    },
  });
}

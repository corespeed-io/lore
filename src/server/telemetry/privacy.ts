import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const SAFE_SPAN_ATTRIBUTES = new Set([
  "error.type",
  "http.method",
  "http.request.method",
  "http.response.status_code",
  "http.status_code",
  "lore.operation",
  "lore.outcome",
  "next.route",
  "next.span_type",
]);

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const OPAQUE_SEGMENT_PATTERN = /\/[A-Za-z0-9_-]{20,}(?=\/|\s|$)/gu;

export function privacySafeSpanName(name: string): string {
  return name
    .split("?", 1)[0]
    .replace(UUID_PATTERN, ":id")
    .replace(OPAQUE_SEGMENT_PATTERN, "/:id")
    .slice(0, 256);
}

export function scrubSpanForPrivacy(span: ReadableSpan): void {
  const mutable = span as ReadableSpan & {
    attributes: Record<string, unknown>;
    name: string;
    status: { code: number; message?: string };
  };
  mutable.name = privacySafeSpanName(mutable.name);
  for (const key of Object.keys(mutable.attributes)) {
    if (!SAFE_SPAN_ATTRIBUTES.has(key)) {
      delete mutable.attributes[key];
      continue;
    }
    const value = mutable.attributes[key];
    if (typeof value === "string") {
      mutable.attributes[key] = privacySafeSpanName(value);
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      mutable.attributes[key] = value.map(privacySafeSpanName);
    }
  }
  if (mutable.status.message) delete mutable.status.message;
  for (const event of mutable.events) {
    for (const key of Object.keys(event.attributes ?? {})) {
      if (key !== "exception.type") {
        delete event.attributes?.[key];
      } else if (typeof event.attributes?.[key] === "string") {
        event.attributes[key] = privacySafeSpanName(event.attributes[key]);
      }
    }
  }
  for (const link of mutable.links) {
    for (const key of Object.keys(link.attributes ?? {})) delete link.attributes?.[key];
  }
}

export class PrivacySpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    scrubSpanForPrivacy(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

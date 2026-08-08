import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";

type DependencyName = "embedding";

interface DependencyState {
  failedAt?: string;
  status: "degraded" | "ok" | "unknown";
}

const dependencyState = new Map<DependencyName, DependencyState>();
const tracer = trace.getTracer("lore.portable-core", "1.0.0");
const meter = metrics.getMeter("lore.portable-core", "1.0.0");
const operationCounter = meter.createCounter("lore.operations", {
  description: "Lore operations grouped only by bounded operation and outcome names",
});
const operationDuration = meter.createHistogram("lore.operation.duration", {
  description: "Lore operation duration in milliseconds",
  unit: "ms",
});

export function markDependencyFailure(name: DependencyName): void {
  dependencyState.set(name, { status: "degraded", failedAt: new Date().toISOString() });
}

export function markDependencySuccess(name: DependencyName): void {
  dependencyState.set(name, { status: "ok" });
}

export function runtimeDependencyStatus(name: DependencyName): DependencyState {
  return dependencyState.get(name) ?? { status: "unknown" };
}

export async function observeOperation<Result>(
  operation: string,
  use: () => Promise<Result>,
): Promise<Result> {
  return tracer.startActiveSpan(`lore.${operation}`, async (span) => {
    const startedAt = performance.now();
    try {
      const result = await use();
      operationCounter.add(1, { "lore.operation": operation, "lore.outcome": "ok" });
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      operationCounter.add(1, { "lore.operation": operation, "lore.outcome": "error" });
      span.setStatus({ code: SpanStatusCode.ERROR });
      // Error messages can contain provider payloads or request data. Record only
      // the bounded error class, never message, content, query, or tenant ids.
      span.setAttribute(
        "error.type",
        error instanceof Error && error.name ? error.name.slice(0, 128) : "UnknownError",
      );
      throw error;
    } finally {
      operationDuration.record(performance.now() - startedAt, { "lore.operation": operation });
      span.end();
    }
  });
}

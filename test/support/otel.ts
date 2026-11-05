// In-memory OpenTelemetry for tests: real spans and metrics, read back instead of exported.
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import type { LogSink } from "../../src/shared/logger";
import { createTelemetry, type Telemetry } from "../../src/shared/telemetry";

export interface MemoryTelemetry {
  telemetry: Telemetry;
  /** Finished spans, oldest first. */
  spans(): ReadableSpan[];
  /** Spans with this name. */
  named(name: string): ReadableSpan[];
  /** Latest value of each metric data point, keyed `name{attr=v,...}`. */
  metrics(): Promise<Record<string, number>>;
}

export function memoryTelemetry(serviceName = "test"): MemoryTelemetry {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  // Long interval: collection happens only on forceFlush, so tests never wait on a timer.
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000,
  });
  const telemetry = createTelemetry({
    serviceName,
    spanExporter,
    metricReader,
  });
  return {
    telemetry,
    spans: () => spanExporter.getFinishedSpans(),
    named: (name) =>
      spanExporter.getFinishedSpans().filter((s) => s.name === name),
    async metrics() {
      metricExporter.reset();
      await telemetry.forceFlush();
      const out: Record<string, number> = {};
      for (const rm of metricExporter.getMetrics()) {
        for (const sm of rm.scopeMetrics) {
          for (const m of sm.metrics) {
            for (const dp of m.dataPoints) {
              const attrs = Object.entries(dp.attributes)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([k, v]) => `${k}=${v}`)
                .join(",");
              out[`${m.descriptor.name}{${attrs}}`] =
                typeof dp.value === "number" ? dp.value : dp.value.count;
            }
          }
        }
      }
      return out;
    },
  };
}

/** A log sink that keeps lines, for asserting on structured output. */
export function captureSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (l) => void lines.push(l),
    err: (l) => void lines.push(l),
  };
}

// OpenTelemetry setup shared by folie-server and the agent: a tracer, a few metrics, and the `Observability` port the service uses.
// Exporters are injectable so tests read spans and metrics in memory; in production an OTLP endpoint
// (OTEL_EXPORTER_OTLP_ENDPOINT) turns export on, and unset means spans still propagate but nothing is shipped.
import { trace, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { TRACER_NAME, installContextManager } from "./trace";
import type { SessionUsage } from "./types";

/** What the service reports. A no-op default keeps unit tests and callers without telemetry simple. */
export interface Metrics {
  sessionReported(r: {
    agent: string;
    outcome: string;
    usage?: SessionUsage;
    inboxLatenciesMs: number[];
  }): void;
  toolEnded(e: {
    agent: string;
    tool: string;
    replayable: boolean;
    isError: boolean;
  }): void;
  /** Registers a gauge callback reporting every agent's unread depth at each collection. */
  observeInboxDepth(
    read: () => Promise<{ agent: string; depth: number }[]>,
  ): void;
  /** One stored task state transition (e.g. available -> claimed). */
  taskTransition(e: { from: string; to: string }): void;
  /** A failed session's work parked; reason is a bounded outcome value only. */
  taskFailed(e: { reason: string }): void;
  /** Create-to-lease latency for one leased message. */
  messageDeliveryLatency(e: { agent: string; ms: number }): void;
  /** A publish that reached zero subscribers. */
  publicationUndelivered(): void;
  /** One recorded verdict; kind is a bounded constant (never free-text check). */
  verificationResult(e: { kind: string; result: string }): void;
  /** Budget flipped to exhausted (once per flip). */
  budgetExhausted(e: { dim: string }): void;
  /** Budget committed past its limit (emitted with exhausted on the same flip). */
  budgetOverrun(e: { dim: string }): void;
  /** One accepted task proposal. */
  proposalRecorded(e: { outcome: string }): void;
  /** One stored goal evaluation verdict. */
  goalEvaluated(e: { outcome: string }): void;
  /** LLM cost whose basis is known (recordUsage); reuses folie.llm.cost. */
  llmCost(e: { amount: number; basis: string }): void;
}

export interface Observability {
  tracer: Tracer;
  metrics: Metrics;
}

export const noopMetrics: Metrics = {
  sessionReported() {},
  toolEnded() {},
  observeInboxDepth() {},
  taskTransition() {},
  taskFailed() {},
  messageDeliveryLatency() {},
  publicationUndelivered() {},
  verificationResult() {},
  budgetExhausted() {},
  budgetOverrun() {},
  proposalRecorded() {},
  goalEvaluated() {},
  llmCost() {},
};
export const noopObservability = (): Observability => ({
  tracer: trace.getTracer(TRACER_NAME),
  metrics: noopMetrics,
});

export interface TelemetryOptions {
  serviceName: string;
  /** Base URL of an OTLP/HTTP collector, e.g. http://otel-collector:4318. */
  otlpEndpoint?: string;
  /** Test seams: take precedence over `otlpEndpoint`. */
  spanExporter?: SpanExporter;
  metricReader?: MetricReader;
  /** Default true. An agent has no metrics of its own (the server derives them from reports and events), so it turns this off. */
  exportMetrics?: boolean;
}

export interface Telemetry extends Observability {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createTelemetry(opts: TelemetryOptions): Telemetry {
  installContextManager();
  const resource = resourceFromAttributes({ "service.name": opts.serviceName });

  const spanProcessors = opts.spanExporter
    ? [new SimpleSpanProcessor({ exporter: opts.spanExporter })]
    : opts.otlpEndpoint
      ? [
          new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({
              url: `${opts.otlpEndpoint}/v1/traces`,
            }),
          }),
        ]
      : [];
  const tracerProvider = new TracerProvider({ resource, spanProcessors });

  const reader =
    opts.metricReader ??
    (opts.otlpEndpoint && opts.exportMetrics !== false
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: `${opts.otlpEndpoint}/v1/metrics`,
          }),
          exportIntervalMillis: 15_000,
        })
      : undefined);
  const meterProvider = new MeterProvider({
    resource,
    readers: reader ? [reader] : [],
  });
  const meter = meterProvider.getMeter(TRACER_NAME);

  const tokens = meter.createCounter("folie.llm.tokens", {
    description: "Model tokens used by sessions",
    unit: "{token}",
  });
  const cost = meter.createCounter("folie.llm.cost", {
    description: "Estimated model spend",
    unit: "USD",
  });
  const toolCalls = meter.createCounter("folie.tool.calls", {
    description: "Tool invocations",
  });
  const toolFailures = meter.createCounter("folie.tool.failures", {
    description: "Tool invocations that returned an error",
  });
  const outcomes = meter.createCounter("folie.session.outcome", {
    description: "Settled sessions by outcome",
  });
  const latency = meter.createHistogram("folie.inbox.latency", {
    description: "Time from message delivery to the session that acked it",
    unit: "ms",
  });
  const depth = meter.createObservableGauge("folie.inbox.depth", {
    description: "Unread messages per agent",
  });
  const taskTransition = meter.createCounter("folie.task.transition", {
    description: "Task state transitions",
  });
  const taskFailed = meter.createCounter("folie.task.failed", {
    description: "Tasks parked by a failed session",
  });
  const deliveryLatency = meter.createHistogram("folie.message.delivery.latency", {
    description: "Time from message creation to lease",
    unit: "ms",
  });
  const undelivered = meter.createCounter("folie.publication.undelivered", {
    description: "Publishes that reached zero subscribers",
  });
  const verificationResult = meter.createCounter("folie.verification.result", {
    description: "Recorded verification verdicts",
  });
  const budgetExhausted = meter.createCounter("folie.budget.exhausted", {
    description: "Budgets flipped to exhausted",
  });
  const budgetOverrun = meter.createCounter("folie.budget.overrun", {
    description: "Budgets committed past their limit",
  });
  const proposal = meter.createCounter("folie.proposal", {
    description: "Task proposals by outcome",
  });
  const goalOutcome = meter.createCounter("folie.goal.outcome", {
    description: "Goal evaluation verdicts",
  });

  const metrics: Metrics = {
    sessionReported({ agent, outcome, usage, inboxLatenciesMs }) {
      outcomes.add(1, { outcome, agent_name: agent });
      for (const ms of inboxLatenciesMs)
        latency.record(ms, { agent_name: agent });
      if (!usage) return;
      tokens.add(usage.promptTokens, { type: "prompt", agent_name: agent });
      tokens.add(usage.completionTokens, {
        type: "completion",
        agent_name: agent,
      });
      cost.add(usage.costUsd, { agent_name: agent });
    },
    toolEnded({ agent, tool, replayable, isError }) {
      const attrs = {
        agent_name: agent,
        "tool.name": tool,
        "tool.replayable": replayable,
      };
      toolCalls.add(1, attrs);
      if (isError) toolFailures.add(1, attrs);
    },
    observeInboxDepth(read) {
      depth.addCallback(async (result) => {
        for (const { agent, depth: n } of await read())
          result.observe(n, { agent_name: agent });
      });
    },
    taskTransition({ from, to }) {
      taskTransition.add(1, { from, to });
    },
    taskFailed({ reason }) {
      taskFailed.add(1, { reason });
    },
    messageDeliveryLatency({ agent, ms }) {
      deliveryLatency.record(ms, { agent_name: agent });
    },
    publicationUndelivered() {
      undelivered.add(1);
    },
    verificationResult({ kind, result }) {
      verificationResult.add(1, { "verification.kind": kind, result });
    },
    budgetExhausted({ dim }) {
      budgetExhausted.add(1, { dim });
    },
    budgetOverrun({ dim }) {
      budgetOverrun.add(1, { dim });
    },
    proposalRecorded({ outcome }) {
      proposal.add(1, { outcome });
    },
    goalEvaluated({ outcome }) {
      goalOutcome.add(1, { outcome });
    },
    llmCost({ amount, basis }) {
      cost.add(amount, { cost_basis: basis });
    },
  };

  return {
    tracer: tracerProvider.getTracer(TRACER_NAME),
    metrics,
    forceFlush: async () => {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

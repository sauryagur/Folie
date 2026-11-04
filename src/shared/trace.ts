// W3C Trace Context plumbing shared by folie-server, the agent program and the CLI.
// Contexts cross every process boundary as `traceparent` / `tracestate` strings: HTTP headers between
// agents, the CLI and folie-server, gRPC metadata toward ax and Substrate, and columns on stored rows.
import { ROOT_CONTEXT, context, trace, type Context, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export const TRACER_NAME = "folie";

export interface TraceHeaders {
  traceparent?: string | null;
  tracestate?: string | null;
}

const propagator = new W3CTraceContextPropagator();

const setter = { set: (carrier: Record<string, string>, key: string, value: string) => void (carrier[key] = value) };
const getter = {
  get: (carrier: TraceHeaders, key: string) => carrier[key as keyof TraceHeaders] ?? undefined,
  keys: (carrier: TraceHeaders) => Object.keys(carrier),
};

let contextManagerInstalled = false;

/** Makes `context.with` follow async calls. Idempotent; call once at process start (and in tests). */
export function installContextManager(): void {
  if (contextManagerInstalled) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  contextManagerInstalled = true;
}

/** The headers that carry `ctx` (default: the active context). Empty when no span is active. */
export function traceHeaders(ctx: Context = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, setter);
  return carrier;
}

/** The context a `traceparent`/`tracestate` pair describes. An absent or malformed pair yields the root context. */
export function contextFrom(h: TraceHeaders | null | undefined): Context {
  if (!h?.traceparent) return ROOT_CONTEXT;
  return propagator.extract(ROOT_CONTEXT, { traceparent: h.traceparent, ...(h.tracestate ? { tracestate: h.tracestate } : {}) }, getter);
}

/** Reads trace headers from a Node/Bun HTTP request header bag (lowercased keys, string or string[] values). */
export function headersOf(raw: Record<string, string | string[] | undefined>): TraceHeaders {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return { traceparent: one(raw.traceparent), tracestate: one(raw.tracestate) };
}

/** Trace headers for the span active in `ctx`, shaped for storing on a row (both null when there is none). */
export function storableTrace(ctx: Context = context.active()): { traceparent: string | null; tracestate: string | null } {
  const h = traceHeaders(ctx);
  return { traceparent: h.traceparent ?? null, tracestate: h.tracestate ?? null };
}

/** `trace_id` and `span_id` of the active span, for correlating log lines with traces. */
export function activeSpanIds(ctx: Context = context.active()): { trace_id: string; span_id: string } | null {
  const sc = trace.getSpan(ctx)?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : null;
}

/**
 * Runs `fn` inside a new span (child of the active context, or of `parent` when given) and ends it.
 * A thrown error marks the span failed, records the exception, and is rethrown.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  opts: SpanOptions & { parent?: Context },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const { parent, ...spanOpts } = opts;
  return tracer.startActiveSpan(name, spanOpts, parent ?? context.active(), async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      failSpan(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Marks a span failed with the error's message and records the exception on it. */
export function failSpan(span: Span, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  span.recordException(err);
  span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: err.message });
}

import { ROOT_CONTEXT, context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { jsonLogger } from "../../src/shared/logger";
import { activeSpanIds, contextFrom, headersOf, storableTrace, traceHeaders, withSpan } from "../../src/shared/trace";
import { captureSink, memoryTelemetry } from "../support/otel";

const mem = memoryTelemetry();
const { tracer } = mem.telemetry;

describe("W3C trace context", () => {
  it("round-trips a span through traceparent/tracestate: a span started from it is that span's child", async () => {
    const parent = tracer.startSpan("parent");
    const h = traceHeaders(trace.setSpan(ROOT_CONTEXT, parent));
    expect(h.traceparent).toBe(`00-${parent.spanContext().traceId}-${parent.spanContext().spanId}-01`);

    const child = tracer.startSpan("child", {}, contextFrom(h));
    child.end();
    parent.end();
    const [exported] = mem.named("child");
    expect(exported!.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(exported!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("carries tracestate through", () => {
    const ctx = contextFrom({ traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`, tracestate: "vendor=abc" });
    expect(trace.getSpan(ctx)!.spanContext().traceState?.serialize()).toBe("vendor=abc");
  });

  it.each([[undefined], [null], [{}], [{ traceparent: null }], [{ traceparent: "garbage" }], [{ traceparent: `00-${"0".repeat(32)}-${"0".repeat(16)}-01` }]])(
    "treats %j as no parent",
    (h) => {
      expect(trace.getSpan(contextFrom(h))).toBeUndefined();
    },
  );

  it("emits no headers when no span is active, and nulls for storage", () => {
    expect(traceHeaders()).toEqual({});
    expect(storableTrace()).toEqual({ traceparent: null, tracestate: null });
    expect(activeSpanIds()).toBeNull();
  });

  it("reads the first value of repeated headers", () => {
    expect(headersOf({ traceparent: ["a", "b"], tracestate: undefined })).toEqual({ traceparent: "a", tracestate: undefined });
  });
});

describe("withSpan", () => {
  it("makes the span active inside, so storable context and log correlation see it", async () => {
    await withSpan(tracer, "outer", {}, async (span) => {
      expect(activeSpanIds()).toEqual({ trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });
      expect(storableTrace().traceparent).toContain(span.spanContext().spanId);
    });
    expect(activeSpanIds()).toBeNull();
  });

  it("nests under the active span by default and under `parent` when given", async () => {
    const remote = contextFrom({ traceparent: `00-${"3".repeat(32)}-${"4".repeat(16)}-01` });
    await withSpan(tracer, "wp-outer", {}, () => withSpan(tracer, "wp-inner", {}, async () => {}));
    await withSpan(tracer, "wp-remote", { parent: remote }, async () => {});

    expect(mem.named("wp-inner")[0]!.parentSpanContext?.spanId).toBe(mem.named("wp-outer")[0]!.spanContext().spanId);
    expect(mem.named("wp-remote")[0]!.parentSpanContext?.spanId).toBe("4".repeat(16));
  });

  it("records the exception, marks the span failed, ends it, and rethrows", async () => {
    await expect(withSpan(tracer, "boom", {}, async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    const [span] = mem.named("boom");
    expect(span!.status).toMatchObject({ code: 2, message: "nope" });
    expect(span!.events.find((e) => e.name === "exception")!.attributes).toMatchObject({ "exception.message": "nope" });
    expect(context.active()).toBe(ROOT_CONTEXT);
  });
});

describe("structured logger", () => {
  it("writes one JSON object per line with fields, and routes errors to the error stream", () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = jsonLogger({ agent_name: "a" }, { out: (l) => out.push(l), err: (l) => err.push(l) });
    log.log("hello %s", "world");
    log.error("bad", 7);

    expect(JSON.parse(out[0]!)).toMatchObject({ level: "info", msg: "hello world", agent_name: "a" });
    expect(JSON.parse(err[0]!)).toMatchObject({ level: "error", msg: "bad 7" });
    expect(Date.parse(JSON.parse(out[0]!).ts)).not.toBeNaN();
  });

  it("adds trace_id and span_id only while a span is active", async () => {
    const sink = captureSink();
    const log = jsonLogger({}, sink);
    log.log("before");
    await withSpan(tracer, "logged", {}, async () => log.log("inside"));
    const [before, inside] = sink.lines.map((l) => JSON.parse(l));

    expect(before).not.toHaveProperty("trace_id");
    expect(inside).toMatchObject({ trace_id: mem.named("logged")[0]!.spanContext().traceId, span_id: mem.named("logged")[0]!.spanContext().spanId });
  });

  it("child loggers add fields without changing the parent", () => {
    const sink = captureSink();
    const base = jsonLogger({ agent_name: "a" }, sink);
    base.child({ work_item_id: 4 }).log("x");
    base.log("y");
    expect(JSON.parse(sink.lines[0]!)).toMatchObject({ agent_name: "a", work_item_id: 4 });
    expect(JSON.parse(sink.lines[1]!)).not.toHaveProperty("work_item_id");
  });
});

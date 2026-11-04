import type * as grpc from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { callUnary } from "../../src/server/grpc";
import { withSpan } from "../../src/shared/trace";
import { memoryTelemetry } from "../support/otel";

const { tracer } = memoryTelemetry().telemetry;

/** A client whose method records the metadata it was called with. */
function recordingClient() {
  const seen: { md?: grpc.Metadata } = {};
  const client = {
    Echo(req: unknown, md: grpc.Metadata, cb: (e: null, res: unknown) => void) {
      seen.md = md;
      cb(null, { echoed: req });
    },
  };
  return { client: client as unknown as grpc.Client, seen };
}

describe("callUnary trace propagation", () => {
  it("sends the active span as traceparent gRPC metadata, so ax and Substrate calls join the trace", async () => {
    const { client, seen } = recordingClient();
    await withSpan(tracer, "grpc-parent", {}, async (span) => {
      expect(await callUnary(client, "Echo", { x: 1 })).toEqual({ echoed: { x: 1 } });
      expect(seen.md!.get("traceparent")).toEqual([`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`]);
    });
  });

  it("sends no trace metadata when no span is active", async () => {
    const { client, seen } = recordingClient();
    await callUnary(client, "Echo", {});
    expect(seen.md!.get("traceparent")).toEqual([]);
  });

  it("rejects an unknown method by name", () => {
    expect(() => callUnary(recordingClient().client, "Nope", {})).toThrow(/no method Nope/);
  });
});

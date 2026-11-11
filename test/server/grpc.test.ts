import type * as grpc from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import {
  AX_PROTO,
  SUBSTRATE_PROTO,
  callUnary,
  loadService,
} from "../../src/server/grpc";
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
      expect(await callUnary(client, "Echo", { x: 1 })).toEqual({
        echoed: { x: 1 },
      });
      expect(seen.md!.get("traceparent")).toEqual([
        `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
      ]);
    });
  });

  it("sends no trace metadata when no span is active", async () => {
    const { client, seen } = recordingClient();
    await callUnary(client, "Echo", {});
    expect(seen.md!.get("traceparent")).toEqual([]);
  });

  it("rejects an unknown method by name", () => {
    expect(() => callUnary(recordingClient().client, "Nope", {})).toThrow(
      /no method Nope/,
    );
  });
});

// The wire paths are what the real servers route on; a renamed package (Substrate v1.0.0) breaks them silently.
describe("vendored protos", () => {
  it("load the ax service with every RPC the adapter calls, on the ax.v1alpha1.AX path", () => {
    const AX = loadService(AX_PROTO, ["ax", "v1alpha1", "AX"]);
    for (const m of [
      "GetTask",
      "ListTasks",
      "CreateTask",
      "DeleteTask",
      "SuspendTask",
      "ResumeTask",
      "GetWorkspace",
      "UpdateWorkspace",
    ])
      expect(AX.service[m]?.path).toBe(`/ax.v1alpha1.AX/${m}`);
  });

  it("load Substrate's Control service under package substrate.ateapi.v1", () => {
    const Control = loadService(SUBSTRATE_PROTO, [
      "substrate",
      "ateapi",
      "v1",
      "Control",
    ]);
    expect(Control.service.CreateActorEgressPolicy?.path).toBe(
      "/substrate.ateapi.v1.Control/CreateActorEgressPolicy",
    );
  });

  it("fail loudly on a service path the proto does not define (the pre-1.0 Substrate package)", () => {
    expect(() => loadService(SUBSTRATE_PROTO, ["ateapi", "Control"])).toThrow(
      /has no service ateapi\.Control/,
    );
  });
});

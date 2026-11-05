import { describe, expect, it } from "vitest";
import { otlpGateway } from "../../src/server/otlp-gateway";

const body = new TextEncoder().encode('{"resourceSpans":[]}');

describe("otlpGateway", () => {
  it("accepts and drops when no collector is configured, so agents never retry a disabled feature", async () => {
    const calls: unknown[] = [];
    const gw = otlpGateway(
      undefined,
      async (...a) => (calls.push(a), new Response()),
    );
    expect(
      await gw.forward("traces", body, { contentType: "application/json" }),
    ).toBe(202);
    expect(calls).toEqual([]);
  });

  it("posts the bytes verbatim to <endpoint>/v1/<signal>, keeping content type and encoding", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const gw = otlpGateway(
      "http://collector:4318",
      async (url, init) => (
        (seen = { url, init }),
        new Response(null, { status: 200 })
      ),
    );

    expect(
      await gw.forward("metrics", body, {
        contentType: "application/x-protobuf",
        contentEncoding: "gzip",
      }),
    ).toBe(200);
    expect(seen!.url).toBe("http://collector:4318/v1/metrics");
    expect(seen!.init.headers).toEqual({
      "content-type": "application/x-protobuf",
      "content-encoding": "gzip",
    });
    expect(seen!.init.body).toBe(body);
  });

  it("returns the collector's status, and 502 when it is unreachable (never throws)", async () => {
    const down = otlpGateway("http://c", async () => {
      throw new Error("ECONNREFUSED");
    });
    const rejecting = otlpGateway(
      "http://c",
      async () => new Response(null, { status: 429 }),
    );
    expect(
      await down.forward("logs", body, { contentType: "application/json" }),
    ).toBe(502);
    expect(
      await rejecting.forward("logs", body, {
        contentType: "application/json",
      }),
    ).toBe(429);
  });
});

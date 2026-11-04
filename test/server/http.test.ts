import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { NotFoundError } from "../../src/server/errors";
import { httpServer } from "../../src/server/http";
import type { AgentOps } from "../../src/server/ops";
import { SwarmService } from "../../src/server/service";
import { FolieClient } from "../../src/shared/client";
import type { AgentOp } from "../../src/shared/types";
import type { OtlpGateway } from "../../src/server/otlp-gateway";
import { testStore } from "../support/db";
import { memoryTelemetry } from "../support/otel";

let db: Database;
let reset: () => Promise<void>;
let server: Server;
let base: string;
let client: FolieClient;

/** Records steering calls; "ghost" has no task. */
const opCalls: string[] = [];
const ops: AgentOps = {
  async run(op: AgentOp, agent: string) {
    if (agent === "ghost") throw new NotFoundError(`${agent} has no task`);
    opCalls.push(`${op} ${agent}`);
    return { agent, state: op === "suspend" ? "suspended" : op === "resume" ? "running" : "retired" };
  },
};

const mem = memoryTelemetry();
const forwarded: { signal: string; body: Buffer; contentType: string; contentEncoding?: string }[] = [];
let forwardStatus = 202;
const gateway: OtlpGateway = {
  forward: async (signal, body, { contentType, contentEncoding }) => (forwarded.push({ signal, body: Buffer.from(body), contentType, contentEncoding }), forwardStatus),
};

beforeAll(async () => {
  let store;
  ({ db, store, reset } = await testStore());
  server = httpServer(new SwarmService(store, mem.telemetry), ops, gateway, mem.telemetry).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new FolieClient(base);
});
beforeEach(() => reset());
afterAll(async () => {
  server.close();
  await db.close();
});

const raw = (method: string, path: string, body?: string) => fetch(base + path, { method, body });

describe("API through the typed client", () => {
  it("round-trips goal -> inbox -> report -> work item", async () => {
    const { workItem, message } = await client.submitGoal({ goal: "ship", to: "a" });
    expect(await client.inbox("a")).toEqual([message]);
    expect((await client.agents())[0]).toMatchObject({ name: "a", unread: 1 });

    await client.report({ agent: "a", startedAt: new Date().toISOString(), outcome: "done", summary: "shipped", messageIds: [message!.id] });

    expect(await client.inbox("a")).toEqual([]);
    expect(await client.workItem(workItem.id)).toMatchObject({ workItem: { state: "done" }, report: { summary: "shipped" } });
  });

  it("serves the message log with a cursor, filters, and the audit trail of acked mail", async () => {
    const a = await client.send({ from: "x", to: "a", body: "1" });
    await client.send({ from: "a", to: "b", body: "2" });
    await client.subscribe("news", { agent: "b" });
    await client.publish("news", { from: "human", body: "3" });

    expect((await client.messages()).map((m) => m.body)).toEqual(["1", "2", "3"]);
    expect((await client.messages({ after: a.id })).map((m) => m.body)).toEqual(["2", "3"]);
    expect((await client.messages({ limit: 1 })).map((m) => m.body)).toEqual(["3"]);
    expect((await client.messages({ topic: "news" })).map((m) => m.body)).toEqual(["3"]);
    expect((await client.messages({ agent: "a" })).map((m) => m.body)).toEqual(["1", "2"]);

    await client.report({ agent: "a", startedAt: new Date().toISOString(), outcome: "done", summary: "s", messageIds: [a.id] });
    expect((await client.messages()).map((m) => m.body)).toEqual(["1", "2", "3"]); // acked mail stays in the log
  });

  it("lists reports newest first, for one agent or all", async () => {
    for (const agent of ["a", "b"]) {
      const m = await client.send({ from: "h", to: agent, body: "x" });
      await client.report({ agent, startedAt: new Date().toISOString(), outcome: "done", summary: `from ${agent}`, messageIds: [m.id] });
    }
    expect((await client.reports()).map((r) => r.summary)).toEqual(["from b", "from a"]);
    expect((await client.reports({ agent: "a" })).map((r) => r.summary)).toEqual(["from a"]);
  });

  it("routes steering to the ops port and maps its errors", async () => {
    opCalls.length = 0;
    expect(await client.agentOp("suspend", "a")).toEqual({ agent: "a", state: "suspended" });
    expect(await client.agentOp("resume", "a")).toEqual({ agent: "a", state: "running" });
    expect(await client.agentOp("delete", "a")).toEqual({ agent: "a", state: "retired" });
    expect(opCalls).toEqual(["suspend a", "resume a", "delete a"]);
    await expect(client.agentOp("suspend", "ghost")).rejects.toThrow(/404 ghost has no task/);
  });

  it("queues a goal that names no agent: no message yet, state queued", async () => {
    const { workItem, message } = await client.submitGoal({ goal: "anyone" });
    expect(message).toBeNull();
    expect((await client.workItem(workItem.id)).workItem.state).toBe("queued");
    expect(await client.agents()).toEqual([]);
  });

  it("delivers peer messages", async () => {
    const m = await client.send({ from: "a", to: "b", body: "hi" });
    expect(await client.inbox("b")).toEqual([m]);
  });

  it("round-trips subscribe -> publish -> inbox -> topics -> unsubscribe", async () => {
    await client.subscribe("releases", { agent: "a" });
    await client.subscribe("releases", { agent: "b" });
    expect(await client.topics()).toEqual([{ topic: "releases", subscribers: ["a", "b"] }]);

    expect(await client.publish("releases", { from: "a", body: "v2" })).toEqual({ delivered: 1 });
    expect(await client.inbox("b")).toMatchObject([{ topic: "releases", from: "a", body: "v2" }]);
    expect(await client.inbox("a")).toEqual([]);

    await client.unsubscribe("releases", { agent: "b" });
    expect(await client.publish("releases", { from: "human", body: "again" })).toEqual({ delivered: 1 });
  });

  it("encodes topic names in the path and rejects malformed ones with 400", async () => {
    await expect(client.publish("Bad Topic", { from: "a", body: "x" })).rejects.toThrow(/400 topic: invalid topic name/);
  });

  it("surfaces server errors with status and message", async () => {
    await expect(client.submitGoal({ goal: "" })).rejects.toThrow(/400 goal: required/);
    await expect(client.workItem(404)).rejects.toThrow(/404 work item 404/);
  });
});

describe("HTTP contract", () => {
  it("serves /healthz without touching the database", async () => {
    expect((await raw("GET", "/healthz")).status).toBe(200);
  });

  it("404s unknown paths and 405s wrong methods", async () => {
    expect((await raw("GET", "/nope")).status).toBe(404);
    expect((await raw("GET", "/v1/work-items")).status).toBe(405);
  });

  it.each([["not json"], ["[]"], ["null"], ['"str"']])("400s a non-object body %s", async (body) => {
    expect((await raw("POST", "/v1/messages", body)).status).toBe(400);
  });

  it("400s an oversized body", async () => {
    const res = await raw("POST", "/v1/messages", JSON.stringify({ from: "a", to: "b", body: "x".repeat(2 << 20) }));
    expect(res.status).toBe(400);
  });

  it("400s a malformed agent name in the inbox path", async () => {
    expect((await raw("GET", "/v1/agents/Bad%20Name/inbox")).status).toBe(400);
  });

  it.each(["after=abc", "limit=0", "limit=1.5", "after=-1", "topic=Bad%20Topic", "agent=Bad%20Agent"])("400s bad message query %s", async (qs) => {
    expect((await raw("GET", `/v1/messages?${qs}`)).status).toBe(400);
  });

  it("404s an unknown agent op and 405s a GET on a real one", async () => {
    expect((await raw("POST", "/v1/agents/a/explode")).status).toBe(404);
    expect((await raw("GET", "/v1/agents/a/suspend")).status).toBe(405);
  });
});

describe("steering poll and transcript API", () => {
  it("GET inbox?workItem= returns that work item's mail plus mail with none, and ?workItem=none only the latter", async () => {
    const w1 = (await client.submitGoal({ goal: "one", to: "a" })).workItem;
    const w2 = (await client.submitGoal({ goal: "two", to: "a" })).workItem;
    await client.send({ from: "x", to: "a", body: "loose" });

    expect((await client.inbox("a", { workItem: w1.id })).map((m) => m.body)).toEqual(["one", "loose"]);
    expect((await client.inbox("a", { workItem: w2.id })).map((m) => m.body)).toEqual(["two", "loose"]);
    expect((await client.inbox("a", { workItem: "none" })).map((m) => m.body)).toEqual(["loose"]);
    expect(await client.inbox("a")).toHaveLength(3);
  });

  it.each(["workItem=abc", "workItem=1.5"])("400s a bad inbox scope %s", async (qs) => {
    expect((await raw("GET", `/v1/agents/a/inbox?${qs}`)).status).toBe(400);
  });

  it("ingests transcript events idempotently and serves them back with filters", async () => {
    const events = [
      { seq: 0, type: "session_start" as const, data: {} },
      { seq: 1, type: "artifact" as const, data: { path: "out/proof.txt", sha256: "ab" } },
    ];
    const batch = { agent: "a", sessionId: "s1", scope: "wi:1", events };
    expect(await client.sessionEvents(batch)).toEqual({ stored: 2 });
    expect(await client.sessionEvents(batch)).toEqual({ stored: 0 });

    expect((await client.readEvents({ scope: "wi:1" })).map((e) => e.type)).toEqual(["session_start", "artifact"]);
    expect((await client.readEvents({ type: "artifact" }))[0]!.data).toEqual({ path: "out/proof.txt", sha256: "ab" });
  });

  it("400s an invalid batch and a bad event filter", async () => {
    expect((await raw("POST", "/v1/sessions/events", JSON.stringify({ agent: "a", sessionId: "s", scope: "wi:1", events: [] }))).status).toBe(400);
    expect((await raw("GET", "/v1/sessions/events?type=dance")).status).toBe(400);
    expect((await raw("GET", "/v1/sessions/events?after=x")).status).toBe(400);
  });

  it("serves earlier tool attempts for a scope, excluding the asking session", async () => {
    const call = { callId: "1", tool: "message_send", replayable: false, args: { to: "b" } };
    await client.sessionEvents({ agent: "a", sessionId: "old", scope: "wi:1", events: [{ seq: 0, type: "tool_start", data: call }] });
    await client.sessionEvents({ agent: "a", sessionId: "cur", scope: "wi:1", events: [{ seq: 0, type: "tool_start", data: { ...call, callId: "9" } }] });

    expect(await client.attempts("a", "wi:1", "cur")).toEqual([{ sessionId: "old", callId: "1", tool: "message_send", replayable: false, args: { to: "b" }, state: "interrupted" }]);
    expect((await raw("GET", "/v1/sessions/attempts?agent=a&scope=bogus")).status).toBe(400);
  });

  it("makes a send with a requestId at-most-once over the wire", async () => {
    const first = await client.send({ from: "a", to: "b", body: "x", requestId: "r1" });
    const again = await client.send({ from: "a", to: "b", body: "x", requestId: "r1" });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    expect(await client.inbox("b")).toHaveLength(1);
  });
});

describe("telemetry through HTTP", () => {
  it("a request's traceparent makes its server span a child of the caller's span", async () => {
    const parent = mem.telemetry.tracer.startSpan("caller");
    const { traceId, spanId } = parent.spanContext();
    await fetch(`${base}/v1/agents`, { headers: { traceparent: `00-${traceId}-${spanId}-01`, tracestate: "vendor=1" } });
    parent.end();

    const span = mem.named("folie.http.request").find((s) => s.parentSpanContext?.spanId === spanId)!;
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.attributes).toMatchObject({ "http.request.method": "GET", "url.path": "/v1/agents" });
  });

  it("starts a fresh trace for a malformed traceparent instead of rejecting the request", async () => {
    const res = await fetch(`${base}/v1/agents`, { headers: { traceparent: "garbage" } });
    expect(res.status).toBe(200);
  });

  it.each(["traces", "metrics", "logs"] as const)("forwards OTLP %s from a sandbox verbatim and answers with the collector's status", async (signal) => {
    forwardStatus = 200;
    const body = JSON.stringify({ resourceSpans: [] });
    const res = await fetch(`${base}/v1/otlp/v1/${signal}`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body });

    expect(res.status).toBe(200);
    const sent = forwarded.at(-1)!;
    expect(sent).toMatchObject({ signal, contentType: "application/json", contentEncoding: "gzip" });
    expect(sent.body.toString()).toBe(body);
  });

  it("passes the gateway's failure status through so the exporter can retry", async () => {
    forwardStatus = 502;
    expect((await fetch(`${base}/v1/otlp/v1/traces`, { method: "POST", body: "{}" })).status).toBe(502);
  });

  it("does not trace the OTLP pass-through itself", async () => {
    const before = mem.named("folie.http.request").length;
    await fetch(`${base}/v1/otlp/v1/traces`, { method: "POST", body: "{}" });
    expect(mem.named("folie.http.request")).toHaveLength(before);
  });

  it("only accepts POST on the OTLP path", async () => {
    expect((await raw("GET", "/v1/otlp/v1/traces")).status).toBe(404);
  });
});

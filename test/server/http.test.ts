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
import { otlpGateway } from "../../src/server/otlp-gateway";
import { testStore } from "../support/db";

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

beforeAll(async () => {
  let store;
  ({ db, store, reset } = await testStore());
  server = httpServer(new SwarmService(store), ops, otlpGateway(undefined)).listen(0);
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

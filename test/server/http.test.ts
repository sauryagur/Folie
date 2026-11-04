import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { httpServer } from "../../src/server/http";
import { SwarmService } from "../../src/server/service";
import { FolieClient } from "../../src/shared/client";
import { testStore } from "../support/db";

let db: Database;
let reset: () => Promise<void>;
let server: Server;
let base: string;
let client: FolieClient;

beforeAll(async () => {
  let store;
  ({ db, store, reset } = await testStore());
  server = httpServer(new SwarmService(store)).listen(0);
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
});

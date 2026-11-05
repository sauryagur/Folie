// Acceptance for R-1.1–R-1.5 over real HTTP (startCluster). Ponytail: one file, no new harness.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { startCluster } from "../support/cluster";
import type { FakeAx } from "../support/fakes";

const cluster = await startCluster();
const { client, store, tick } = cluster;
let ax: FakeAx;
beforeEach(async () => void ({ ax } = await cluster.reset()));
afterAll(() => cluster.close());

// shortcut: agentClientFor mints a fresh token per call; generation-bump tests mint once via store directly.

describe("R-1.1 unauthenticated + forged identity", () => {
  it("unauthenticated /v1 fails 401; /healthz is public", async () => {
    const url = (client as unknown as { baseUrl?: string }).baseUrl;
    // If private, fallback: the test helper in cluster uses port; we recreate via store? Instead use global fetch to the same origin via relative? No.
    // Minimal: try FolieClient without token
    const { FolieClient } = await import("../../src/shared/client");
    const noAuth = new FolieClient(url ?? "http://invalid", fetch);
    await expect(noAuth.agents()).rejects.toThrow(/401/);
    // /healthz via operator client flow: we know server is up; test via raw fetch to baseUrl + "/healthz"
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
  });

  it("forged from/agent and cross-agent access -> 403", async () => {
    await client.registerAgent("a"); await client.registerAgent("b");
    const asA = await cluster.agentClientFor("a");
    const asB = await cluster.agentClientFor("b");
    // forged from
    await expect(asA.send({ from: "b", to: "a", body: "x" })).rejects.toThrow(/403/);
    // cross inbox
    await expect(asA.inbox("b")).rejects.toThrow(/403/);
    // cross report (needs a message for b, then report as b via a)
    const m = await client.send({ from: "human", to: "b", body: "hi" });
    await expect(asA.report({ agent: "b", startedAt: new Date().toISOString(), outcome: "done", summary: "s", messageIds: [m.id] })).rejects.toThrow(/403/);
    // cross events
    await expect(asA.sessionEvents({ agent: "b", sessionId: "s1", scope: "wi:1", events: [{ seq: 0, type: "session_start", data: {} }] })).rejects.toThrow(/403/);
    await expect(asA.attempts("b", "wi:1")).rejects.toThrow(/403/);
    void asB;
  });
});

describe("R-1.3 agent tokens cannot call operator routes; operator works", () => {
  it("agent -> operator routes 403, operator -> ok", async () => {
    await client.registerAgent("a");
    const asA = await cluster.agentClientFor("a");
    await expect(asA.agents()).rejects.toThrow(/403/);
    await expect(asA.messages()).rejects.toThrow(/403/);
    await expect(asA.reports()).rejects.toThrow(/403/);
    await expect(asA.topics()).rejects.toThrow(/403/);
    await expect(asA.submitGoal({ goal: "x" })).rejects.toThrow(/403/);
    await expect(asA.agentOp("suspend", "a")).rejects.toThrow(/403/);
    await expect(asA.readEvents()).rejects.toThrow(/403/);
    await expect(asA.workItem(1)).rejects.toThrow(/403/);
    // operator works
    expect((await client.agents()).some((x) => x.name === "a")).toBe(true);
    const { workItem } = await client.submitGoal({ goal: "g", to: "a" });
    expect(workItem.state).toBe("assigned");
  });
});

describe("R-1.2 revoked/stale tokens fail; valid agent works", () => {
  it("revoked + stale generation + terminated execution -> 401", async () => {
    await client.registerAgent("a");
    // mint once, inspect token via store
    const cred = await store.auth.getAgentCredential("a");
    const gen = cred?.generation ?? 1;
    const exec = "exec-revoke-test";
    const token = await store.auth.mintAgentToken("a", exec, gen);
    await store.auth.upsertExecution("a", exec, gen, "running");
    const { FolieClient } = await import("../../src/shared/client");
    const baseUrl = (client as unknown as { baseUrl: string }).baseUrl;
    const ac = new FolieClient(baseUrl, fetch, token);
    await expect(ac.inbox("a")).resolves.toEqual([]);
    await store.auth.revokeAgentTokens("a");
    await expect(ac.inbox("a")).rejects.toThrow(/401/);
    // stale generation
    const asBGen = await cluster.agentClientFor("a"); // fresh token at current gen
    // bump generation without revoking hash -> old tokenReplay? Our check is cred.generation !== row.generation
    await store.agents.bumpCredentialGeneration("a");
    // asBGen was minted before bump, so its row generation mismatches
    await expect(asBGen.inbox("a")).rejects.toThrow(/401/);
    // terminated execution
    const cred2 = await store.auth.getAgentCredential("a");
    const exec2 = "exec-lost";
    const token2 = await store.auth.mintAgentToken("a", exec2, cred2!.generation);
    await store.auth.upsertExecution("a", exec2, cred2!.generation, "terminated");
    const ac2 = new FolieClient(baseUrl, fetch, token2);
    await expect(ac2.inbox("a")).rejects.toThrow(/401/);
  });

  it("valid agent can send/report/ingest own events", async () => {
    await client.registerAgent("a"); await client.registerAgent("b");
    const asA = await cluster.agentClientFor("a");
    const asB = await cluster.agentClientFor("b");
    const m = await asA.send({ from: "a", to: "b", body: "hi" });
    expect(m.from).toBe("a");
    expect(await asB.sessionEvents({ agent: "b", sessionId: "s1", scope: "wi:1", events: [{ seq: 0, type: "session_start", data: {} }] })).toEqual({ stored: 1 });
    const r = await asB.report({ agent: "b", startedAt: new Date().toISOString(), outcome: "done", summary: "ok", messageIds: [m.id] });
    expect(r.agent).toBe("b");
  });
});

describe("R-1.5 unknown agent 404; only registration or pool dispatch creates rows", () => {
  it("send/subscribe/inbox to unknown -> 404, no row created", async () => {
    await client.registerAgent("a");
    const asA = await cluster.agentClientFor("a");
    await expect(client.send({ from: "human", to: "ghost-x", body: "x" })).rejects.toThrow(/404 unknown agent/);
    await expect(asA.send({ from: "a", to: "ghost-x", body: "x" })).rejects.toThrow(/404 unknown agent/);
    await expect(client.subscribe("news", { agent: "ghost-x" })).rejects.toThrow(/404 unknown agent/);
    await expect(client.inbox("ghost-x")).rejects.toThrow(/404 unknown agent/);
    // publish to existing topic by human is allowed (does not create agent)
    expect((await client.topics()).find((t) => t.topic === "news")).toBeUndefined();
    expect((await client.agents()).find((a) => a.name === "ghost-x")).toBeUndefined();
    // submitGoal to unknown does not create
    await expect(client.submitGoal({ goal: "g", to: "ghost-x" })).rejects.toThrow(/404 unknown agent/);
    expect((await client.agents()).find((a) => a.name === "ghost-x")).toBeUndefined();
  });

  it("only explicit registration or pool dispatch creates agent rows", async () => {
    // queued goal creates no agent yet
    await client.submitGoal({ goal: "g" });
    expect((await client.agents()).find((a) => a.name === "agent-1")).toBeUndefined();
    await tick(); // pool dispatch (internal server action) creates agent-1
    expect((await client.agents()).find((a) => a.name === "agent-1")).toBeDefined();
    // explicit registration
    await client.registerAgent("named-1");
    expect((await client.agents()).find((a) => a.name === "named-1")).toBeDefined();
  });
});

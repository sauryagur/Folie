// Event ledger + SSE stream: same-tx appends, resume/cursor, type and agent filters.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ValidationError } from "../../src/server/errors";
import { httpServer } from "../../src/server/http";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
import type { Database } from "../../src/server/db";
import { testStore } from "../support/db";
import { memoryTelemetry } from "../support/otel";
import type { OtlpGateway } from "../../src/server/otlp-gateway";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
const mem = memoryTelemetry();
let service: SwarmService;
const op = { kind: "operator", name: "operator" } as const;
const asAgent = (name: string) =>
  ({ kind: "agent", name, generation: 1, executionId: "test-exec" }) as const;

beforeAll(async () => {
  ({ db, store, reset } = await testStore());
  service = new SwarmService(store, mem.telemetry);
});
beforeEach(() => reset());
afterAll(() => db.close());

const goalTo = async (to: string, goal = "g") => {
  await service.registerAgent(to);
  const { workItem } = await service.submitGoal({ goal, to }, op);
  return workItem;
};

describe("ledger append", () => {
  it("propose -> task.proposed with agent actor and workItemId payload", async () => {
    const workItem = await goalTo("a");
    const task = await service.proposeTask(
      { agent: "a", workItemId: workItem.id, title: "sub", spec: {} },
      asAgent("a"),
    );
    const events = await store.ledger.list({ types: ["task.*"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("task.proposed");
    expect(events[0]!.actor).toBe("agent:a");
    expect(events[0]!.aggregateId).toBe(String(task.id));
    expect(events[0]!.payload.workItemId).toBe(workItem.id);
  });

  it("failed transition appends nothing", async () => {
    const workItem = await goalTo("a");
    const task = await service.proposeTask(
      { agent: "a", workItemId: workItem.id, title: "sub", spec: {} },
      asAgent("a"),
    );
    await service.claimTask({ agent: "a", taskId: task.id }, asAgent("a"));
    const before = await store.ledger.list({});
    // Second claimant loses -> ValidationError, no new row.
    await service.registerAgent("b");
    await expect(
      service.claimTask({ agent: "b", taskId: task.id }, asAgent("b")),
    ).rejects.toBeInstanceOf(ValidationError);
    const after = await store.ledger.list({});
    expect(after).toHaveLength(before.length);
  });

  it("claim/start/submit appends the full task lifecycle", async () => {
    const workItem = await goalTo("a");
    const task = await service.proposeTask(
      { agent: "a", workItemId: workItem.id, title: "sub", spec: {} },
      asAgent("a"),
    );
    const claim = await service.claimTask(
      { agent: "a", taskId: task.id },
      asAgent("a"),
    );
    await service.startTask(
      { agent: "a", taskId: task.id, fence: claim.fence },
      asAgent("a"),
    );
    await service.submitTask(
      { agent: "a", taskId: task.id, fence: claim.fence, result: { ok: true } },
      asAgent("a"),
    );
    const types = (await store.ledger.list({ types: ["task.*"] })).map(
      (e) => e.type,
    );
    expect(types).toEqual([
      "task.proposed",
      "task.claimed",
      "task.started",
      "task.submitted",
    ]);
  });

  it("types filter and goal filter narrow the ledger", async () => {
    const w1 = await goalTo("a", "first");
    const w2 = await goalTo("b", "second");
    await service.proposeTask(
      { agent: "a", workItemId: w1.id, title: "t", spec: {} },
      asAgent("a"),
    );
    const all = await service.stream({}, op);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const goalOnly = await service.stream({ goal: w1.id }, op);
    expect(
      goalOnly.every(
        (e) =>
          e.payload.workItemId === w1.id ||
          (e.aggregate === "goal" && e.aggregateId === String(w1.id)),
      ),
    ).toBe(true);
    expect(goalOnly.some((e) => e.aggregateId === String(w2.id))).toBe(false);
  });
});

describe("stream auth filtering", () => {
  it("agent sees only own events, never another agent's", async () => {
    const w1 = await goalTo("a");
    const w2 = await goalTo("b");
    await service.proposeTask(
      { agent: "a", workItemId: w1.id, title: "ta", spec: {} },
      asAgent("a"),
    );
    await service.proposeTask(
      { agent: "b", workItemId: w2.id, title: "tb", spec: {} },
      asAgent("b"),
    );
    const asA = await service.stream({}, asAgent("a"));
    expect(asA.length).toBeGreaterThan(0);
    expect(
      asA.every(
        (e) =>
          e.actor === "agent:a" ||
          e.payload.agent === "a" ||
          e.actor === "human:operator",
      ),
    ).toBe(true);
    // Force-override: asking for agent=b still yields only a's rows.
    const forced = await service.stream({ agent: "b" }, asAgent("a"));
    expect(
      forced.every((e) => e.payload.agent !== "b" || e.actor === "agent:a"),
    ).toBe(true);
    expect(forced.length).toBe(asA.length);
  });

  it("operator honors agent filter", async () => {
    const w1 = await goalTo("a");
    await service.proposeTask(
      { agent: "a", workItemId: w1.id, title: "ta", spec: {} },
      asAgent("a"),
    );
    const filtered = await service.stream({ agent: "a" }, op);
    expect(filtered.some((e) => e.payload.agent === "a")).toBe(true);
  });
});

describe("SSE resume over HTTP", () => {
  let server: Server;
  let base: string;
  const gateway: OtlpGateway = { forward: async () => 202 };

  beforeAll(async () => {
    await store.auth.setOperatorToken("op-secret-for-tests");
    server = httpServer(
      new SwarmService(store, mem.telemetry),
      { run: async () => ({ agent: "a", state: "running" }) } as never,
      gateway,
      mem.telemetry,
      store,
      "op-secret-for-tests",
    ).listen(0);
    const listening = Promise.withResolvers<void>();
    server.once("listening", () => listening.resolve());
    await listening.promise;
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("?after=N returns only id>N; Last-Event-ID honored; types filter applies", async () => {
    await goalTo("a");
    const all = (await (
      await fetch(`${base}/v1/stream`, {
        headers: {
          authorization: "Bearer op-secret-for-tests",
          accept: "application/json",
        },
      })
    ).json()) as { id: number; type: string }[];
    expect(all.length).toBeGreaterThan(0);
    const n = all[0]!.id;
    const after = (await (
      await fetch(`${base}/v1/stream?after=${n}`, {
        headers: {
          authorization: "Bearer op-secret-for-tests",
          accept: "application/json",
        },
      })
    ).json()) as { id: number }[];
    expect(after.every((e) => e.id > n)).toBe(true);
    const viaHeader = (await (
      await fetch(`${base}/v1/stream`, {
        headers: {
          authorization: "Bearer op-secret-for-tests",
          accept: "application/json",
          "last-event-id": String(n),
        },
      })
    ).json()) as { id: number }[];
    expect(viaHeader.map((e) => e.id)).toEqual(after.map((e) => e.id));
    const tasksOnly = (await (
      await fetch(`${base}/v1/stream?types=${encodeURIComponent("task.*")}`, {
        headers: {
          authorization: "Bearer op-secret-for-tests",
          accept: "application/json",
        },
      })
    ).json()) as { type: string }[];
    expect(tasksOnly.every((e) => e.type.startsWith("task."))).toBe(true);
  });

  it("SSE frames carry id/event/data", async () => {
    await goalTo("a");
    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/stream`, {
      headers: { authorization: "Bearer op-secret-for-tests" },
      signal: ctrl.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("data:")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    expect(buf).toMatch(/id: \d+/);
    expect(buf).toMatch(/event: /);
    expect(buf).toMatch(/data: /);
    ctrl.abort();
    reader.cancel().catch(() => {});
  });
});

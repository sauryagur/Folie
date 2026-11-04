// Postgres-level guarantees the steering, replay and tracing features stand on.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import type { Store } from "../../src/server/store";
import { testStore } from "../support/db";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
beforeAll(async () => ({ db, store, reset } = await testStore()));
beforeEach(async () => {
  await reset();
  for (const name of ["a", "b", "c"]) await store.agents.touch(name);
});
afterAll(() => db.close());

const tp = (n: number) => ({ traceparent: `00-${"a".repeat(31)}${n}-${"b".repeat(15)}${n}-01`, tracestate: `k=${n}` });
const send = (to: string, body: string, extra: { workItemId?: number; requestId?: string; from?: string; trace?: ReturnType<typeof tp> } = {}) =>
  store.messages.send({ from: extra.from ?? "h", to, body, workItemId: extra.workItemId, requestId: extra.requestId, trace: extra.trace });

describe("inbox scoping for mid-session polling", () => {
  it("a work item's scope sees its own mail plus mail with no work item, never another goal's", async () => {
    const w5 = await store.workItems.create("five", "assigned");
    const w6 = await store.workItems.create("six", "assigned");
    const m5 = await send("a", "for five", { workItemId: w5.id });
    await send("a", "for six", { workItemId: w6.id });
    const loose = await send("a", "no work item");

    expect((await store.messages.unacked("a", { workItem: w5.id })).map((m) => m.id)).toEqual([m5.id, loose.id]);
    expect((await store.messages.unacked("a", { workItem: "none" })).map((m) => m.id)).toEqual([loose.id]);
    expect(await store.messages.unacked("a")).toHaveLength(3);
  });
});

describe("request ids: at-most-once delivery", () => {
  it("a repeated (sender, recipient, requestId) returns the original message and creates nothing", async () => {
    const first = await send("a", "pay invoice 7", { requestId: "k1" });
    const again = await send("a", "pay invoice 7", { requestId: "k1" });

    expect(first.duplicate).toBeUndefined();
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    expect(await store.messages.unacked("a")).toHaveLength(1);
  });

  it("the key is scoped to sender and recipient, and absent keys never dedupe", async () => {
    const k = { requestId: "same" };
    const ids = [await send("a", "1", k), await send("b", "1", k), await send("a", "1", { ...k, from: "other" })].map((m) => m.id);
    expect(new Set(ids).size).toBe(3);

    await send("a", "plain");
    await send("a", "plain");
    expect((await store.messages.unacked("a")).filter((m) => m.body === "plain")).toHaveLength(2);
  });

  it("a repeated topic publish delivers once, and reports the original copies", async () => {
    await store.topics.subscribe("news", "a");
    await store.topics.subscribe("news", "b");
    const first = await store.topics.publish("news", "c", "v2", { requestId: "p1" });
    const again = await store.topics.publish("news", "c", "v2", { requestId: "p1" });

    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.copies.map((m) => m.id)).toEqual(first.copies.map((m) => m.id));
    expect(await store.messages.unacked("a")).toHaveLength(1);
  });
});

describe("trace context on rows", () => {
  it("is stored on work items and messages and read back unchanged", async () => {
    const item = await store.workItems.create("g", "assigned", tp(1));
    const m = await send("a", "x", { workItemId: item.id, trace: tp(2) });

    expect(await store.workItems.get(item.id)).toMatchObject(tp(1));
    expect((await store.messages.unacked("a"))[0]).toMatchObject(tp(2));
    expect(m).toMatchObject(tp(2));
  });

  it("wake demand carries the trace of each agent's OLDEST unread message", async () => {
    await send("a", "old", { trace: tp(1) });
    await send("a", "new", { trace: tp(2) });
    await send("b", "only", { trace: tp(3) });

    expect(await store.agents.wakeDemand()).toEqual([{ name: "a", ...tp(1) }, { name: "b", ...tp(3) }]);
  });

  it("retrace re-parents unread mail only", async () => {
    const read = await send("a", "read", { trace: tp(1) });
    await send("a", "unread", { trace: tp(2) });
    await store.messages.ack("a", [read.id]);

    await store.agents.retrace("a", tp(9));

    expect((await store.messages.unacked("a"))[0]).toMatchObject(tp(9));
    expect((await store.messages.list({ agent: "a" })).find((m) => m.body === "read")).toMatchObject(tp(1));
  });
});

describe("session transcript", () => {
  const batch = (sessionId: string, seqs: number[], type = "message" as const) => ({
    agent: "a",
    sessionId,
    scope: "wi:1",
    traceId: null,
    events: seqs.map((seq) => ({ seq, type, data: { n: seq } })),
  });

  it("is idempotent per (session, seq): a resent batch stores only what is new", async () => {
    expect(await store.events.append(batch("s1", [0, 1, 2]))).toEqual([0, 1, 2]);
    expect(await store.events.append(batch("s1", [1, 2, 3]))).toEqual([3]);
    expect(await store.events.append(batch("s1", [0]))).toEqual([]);
    expect(await store.events.list({ sessionId: "s1" })).toHaveLength(4);
  });

  it("the same seq in two sessions is two events", async () => {
    await store.events.append(batch("s1", [0]));
    expect(await store.events.append(batch("s2", [0]))).toEqual([0]);
  });

  it("filters by agent, scope, type, cursor and limit, oldest first", async () => {
    await store.events.append(batch("s1", [0, 1]));
    await store.events.append({ ...batch("s2", [0]), scope: "mail:4", agent: "b", events: [{ seq: 0, type: "steer", data: {} }] });

    expect((await store.events.list({ scope: "wi:1" })).map((e) => e.seq)).toEqual([0, 1]);
    expect((await store.events.list({ agent: "b" }))[0]).toMatchObject({ type: "steer", scope: "mail:4", sessionId: "s2" });
    expect(await store.events.list({ type: "steer" })).toHaveLength(1);
    const [first] = await store.events.list({ limit: 1 });
    expect((await store.events.list({ after: first!.id })).every((e) => e.id > first!.id)).toBe(true);
  });

  it("toolEvents returns only tool_start/tool_end of the agent's scope, optionally leaving one session out", async () => {
    await store.events.append({
      ...batch("old", [0, 1, 2]),
      events: [
        { seq: 0, type: "tool_start", data: { callId: "1" } },
        { seq: 1, type: "message", data: {} },
        { seq: 2, type: "tool_end", data: { callId: "1" } },
      ],
    });
    await store.events.append({ ...batch("now", [0]), events: [{ seq: 0, type: "tool_start", data: { callId: "9" } }] });

    expect((await store.events.toolEvents("a", "wi:1")).map((e) => e.type)).toEqual(["tool_start", "tool_end", "tool_start"]);
    expect((await store.events.toolEvents("a", "wi:1", "now")).map((e) => e.sessionId)).toEqual(["old", "old"]);
    expect(await store.events.toolEvents("a", "wi:2")).toEqual([]);
  });
});

describe("report usage", () => {
  const record = (usage?: { promptTokens: number; completionTokens: number; costUsd: number; toolCalls: number; toolFailures: number }) =>
    store.reports.record({ agent: "a", startedAt: new Date().toISOString(), outcome: "done", summary: "s", messageIds: [1], usage });

  it("is stored with the report and read back", async () => {
    const usage = { promptTokens: 120, completionTokens: 30, costUsd: 0.0042, toolCalls: 5, toolFailures: 1 };
    expect((await record(usage)).usage).toEqual(usage);
    expect((await store.reports.list({ agent: "a" }))[0]!.usage).toEqual(usage);
  });

  it("is null for a session that reported none (echo runtime, older agents)", async () => {
    expect((await record()).usage).toBeNull();
  });
});

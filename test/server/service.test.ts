import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { NotFoundError, ValidationError } from "../../src/server/errors";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
import { testStore, wakeNames } from "../support/db";

let db: Database;
let store: Store;
let svc: SwarmService;
let reset: () => Promise<void>;
beforeAll(async () => ({ db, store, reset } = await testStore()));
beforeEach(async () => {
  await reset();
  svc = new SwarmService(store);
});
afterAll(() => db.close());

const report = (agent: string, messageIds: number[], outcome: "done" | "failed" = "done") =>
  svc.submitReport({ agent, startedAt: new Date().toISOString(), outcome, summary: "s", messageIds });

/** Submits a goal to a named agent and returns the work item plus its (certain) message. */
async function goalTo(to: string, goal = "g") {
  const { workItem, message } = await svc.submitGoal({ goal, to });
  return { workItem, message: message! };
}

describe("submitGoal", () => {
  it("creates the agent, an assigned work item, and the waking message in one go", async () => {
    const { workItem, message } = await goalTo("alice", "build it");
    expect(workItem).toMatchObject({ goal: "build it", state: "assigned" });
    expect(message).toMatchObject({ from: "human", to: "alice", body: "build it", workItemId: workItem.id });
    expect(await wakeNames(store)).toEqual(["alice"]);
  });

  it("queues a goal with no target: no message, no agent, nobody woken", async () => {
    const { workItem, message } = await svc.submitGoal({ goal: "anyone" });
    expect(message).toBeNull();
    expect(workItem.state).toBe("queued");
    expect(await store.agents.list()).toEqual([]);
    expect(await wakeNames(store)).toEqual([]);
  });

  it.each([
    [{ goal: "" }],
    [{ goal: "   " }],
    [{ goal: "g", to: "Bad Name" }],
    [{ goal: "g", to: "-lead" }],
    [{ goal: "g", to: "x".repeat(70) }],
  ])("rejects invalid input %j and writes nothing", async (req) => {
    await expect(svc.submitGoal(req)).rejects.toBeInstanceOf(ValidationError);
    expect(await store.agents.list()).toEqual([]);
  });
});

describe("dispatchQueued", () => {
  it("assigns queued goals oldest first, each to its own agent while all are busy", async () => {
    const a = (await svc.submitGoal({ goal: "first" })).workItem;
    const b = (await svc.submitGoal({ goal: "second" })).workItem;

    expect(await svc.dispatchQueued(8)).toBe(2);

    expect(await svc.inbox("agent-1")).toMatchObject([{ body: "first", workItemId: a.id, from: "human" }]);
    expect(await svc.inbox("agent-2")).toMatchObject([{ body: "second", workItemId: b.id }]);
    expect((await svc.workItem(a.id)).workItem.state).toBe("assigned");
  });

  it("reuses an idle agent instead of growing the pool", async () => {
    const first = (await svc.submitGoal({ goal: "one" })).workItem;
    await svc.dispatchQueued(8);
    await report("agent-1", [(await svc.inbox("agent-1"))[0]!.id]);
    expect((await svc.workItem(first.id)).workItem.state).toBe("done");

    await svc.submitGoal({ goal: "two" });
    await svc.dispatchQueued(8);

    expect((await svc.listAgents()).map((x) => x.name)).toEqual(["agent-1"]);
    expect(await svc.inbox("agent-1")).toMatchObject([{ body: "two" }]);
  });

  it("stops at the pool ceiling and leaves the rest queued until an agent frees up", async () => {
    const items = [];
    for (const goal of ["a", "b", "c"]) items.push((await svc.submitGoal({ goal })).workItem);

    expect(await svc.dispatchQueued(2)).toBe(2);
    expect((await svc.workItem(items[2]!.id)).workItem.state).toBe("queued");
    expect(await svc.dispatchQueued(2)).toBe(0);

    await report("agent-1", [(await svc.inbox("agent-1"))[0]!.id]);
    expect(await svc.dispatchQueued(2)).toBe(1);
    expect(await svc.inbox("agent-1")).toMatchObject([{ body: "c" }]);
  });

  it("does nothing when the queue is empty", async () => {
    expect(await svc.dispatchQueued(8)).toBe(0);
    expect(await svc.listAgents()).toEqual([]);
  });

  it("never hands unaddressed work to an agent that was addressed by name", async () => {
    await goalTo("lead");
    await report("lead", [(await svc.inbox("lead"))[0]!.id]);
    await svc.submitGoal({ goal: "pool work" });
    await svc.dispatchQueued(8);
    expect(await svc.inbox("lead")).toEqual([]);
    expect(await svc.inbox("agent-1")).toHaveLength(1);
  });
});

describe("send", () => {
  it("wakes an unknown peer by creating it", async () => {
    const m = await svc.send({ from: "alice", to: "bob", body: "please review" });
    expect(m).toMatchObject({ from: "alice", to: "bob", workItemId: null });
    expect((await svc.listAgents()).map((a) => a.name)).toEqual(["bob"]);
  });

  it("validates sender, recipient and body", async () => {
    await expect(svc.send({ from: "", to: "bob", body: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.send({ from: "a", to: "B!", body: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.send({ from: "a", to: "bob", body: "" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("submitReport", () => {
  it("acks consumed messages and marks the work item done", async () => {
    const { workItem, message } = await goalTo("a");
    const r = await report("a", [message.id]);

    expect(r).toMatchObject({ agent: "a", outcome: "done", messageIds: [message.id] });
    expect(await svc.inbox("a")).toEqual([]);
    const view = await svc.workItem(workItem.id);
    expect(view.workItem.state).toBe("done");
    expect(view.report).toMatchObject({ id: r.id, summary: "s" });
  });

  it("parks failed work in blocked, never retries it", async () => {
    const { workItem, message } = await goalTo("a");
    await report("a", [message.id], "failed");
    expect((await svc.workItem(workItem.id)).workItem.state).toBe("blocked");
    expect(await svc.inbox("a")).toEqual([]);
  });

  it("settles every work item behind a batch of messages and leaves plain messages alone", async () => {
    const one = await goalTo("a", "1");
    const two = await goalTo("a", "2");
    const peer = await svc.send({ from: "b", to: "a", body: "fyi" });
    await report("a", [one.message.id, two.message.id, peer.id]);
    expect((await svc.workItem(one.workItem.id)).workItem.state).toBe("done");
    expect((await svc.workItem(two.workItem.id)).workItem.state).toBe("done");
  });

  it("refuses to ack messages that belong to someone else, atomically", async () => {
    const mine = await goalTo("a", "mine");
    const theirs = await goalTo("b", "theirs");
    await expect(report("a", [mine.message.id, theirs.message.id])).rejects.toBeInstanceOf(ValidationError);
    // Nothing moved: mine is still unread and its work item still assigned.
    expect(await svc.inbox("a")).toHaveLength(1);
    expect((await svc.workItem(mine.workItem.id)).workItem.state).toBe("assigned");
  });

  it("refuses a second report for already-acked messages", async () => {
    const { message } = await goalTo("a");
    await report("a", [message.id]);
    await expect(report("a", [message.id])).rejects.toBeInstanceOf(ValidationError);
  });

  it("counts as activity: a just-reported agent is not idle", async () => {
    const { message } = await goalTo("a");
    await store.agents.setState("a", "running");
    await db.query("UPDATE agents SET last_active_at = now() - interval '1 hour'");
    expect(await store.agents.idle("running", 60)).toEqual([]); // unread mail
    await report("a", [message.id]);
    expect(await store.agents.idle("running", 60)).toEqual([]); // quiet period restarted
  });

  it.each([
    ["no messages", { messageIds: [] }],
    ["non-integer ids", { messageIds: [1.5] }],
    ["not an array", { messageIds: undefined as unknown as number[] }],
    ["bad outcome", { messageIds: [1], outcome: "maybe" as "done" }],
    ["empty summary", { messageIds: [1], summary: " " }],
    ["bad timestamp", { messageIds: [1], startedAt: "yesterday-ish" }],
  ])("rejects %s", async (_n, patch) => {
    await expect(
      svc.submitReport({ agent: "a", startedAt: new Date().toISOString(), outcome: "done", summary: "s", ...patch }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("workItem", () => {
  it("is NotFound for unknown ids", async () => {
    await expect(svc.workItem(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("has no report until an agent reports", async () => {
    const { workItem } = await svc.submitGoal({ goal: "g", to: "a" });
    expect(await svc.workItem(workItem.id)).toMatchObject({ workItem: { state: "assigned" }, report: null });
  });
});

describe("topics", () => {
  it("subscribing creates an agent that has never run, so it can be wired up before it exists", async () => {
    expect(await svc.subscribe("news", { agent: "newcomer" })).toEqual({ topic: "news", agent: "newcomer" });
    expect((await svc.listAgents()).map((a) => a.name)).toEqual(["newcomer"]);
    expect(await svc.listTopics()).toEqual([{ topic: "news", subscribers: ["newcomer"] }]);
  });

  it("publish puts a copy in each subscriber's inbox, naming the topic and the sender", async () => {
    await svc.subscribe("news", { agent: "a" });
    await svc.subscribe("news", { agent: "b" });

    expect(await svc.publish("news", { from: "human", body: "ship it" })).toEqual({ delivered: 2 });

    for (const who of ["a", "b"]) {
      expect(await svc.inbox(who)).toMatchObject([{ from: "human", topic: "news", body: "ship it", workItemId: null }]);
    }
  });

  it("an agent publishing does not wake itself", async () => {
    await svc.subscribe("news", { agent: "a" });
    await svc.subscribe("news", { agent: "b" });
    expect(await svc.publish("news", { from: "a", body: "x" })).toEqual({ delivered: 1 });
    expect(await svc.inbox("a")).toEqual([]);
  });

  it("topic mail is acked by the same report as any other mail, and touches no work item", async () => {
    await svc.subscribe("news", { agent: "a" });
    await svc.publish("news", { from: "human", body: "x" });
    const [m] = await svc.inbox("a");
    await report("a", [m!.id]);
    expect(await svc.inbox("a")).toEqual([]);
  });

  it("unsubscribe stops delivery", async () => {
    await svc.subscribe("news", { agent: "a" });
    await svc.unsubscribe("news", { agent: "a" });
    expect(await svc.publish("news", { from: "human", body: "x" })).toEqual({ delivered: 0 });
  });

  it.each(["Bad Topic", "-lead", "", "x".repeat(70)])("rejects topic name %j", async (topic) => {
    await expect(svc.subscribe(topic, { agent: "a" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.publish(topic, { from: "a", body: "x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a bad agent, an empty body and an empty sender", async () => {
    await expect(svc.subscribe("news", { agent: "Bad!" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.publish("news", { from: "a", body: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.publish("news", { from: "", body: "x" })).rejects.toBeInstanceOf(ValidationError);
    expect(await svc.listAgents()).toEqual([]);
  });
});

describe("operator reads", () => {
  it("messages validates its filters before touching the store", async () => {
    for (const bad of [{ after: -1 }, { after: 1.5 }, { limit: 0 }, { limit: 2.5 }]) {
      await expect(svc.messages(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(svc.messages({ topic: "Bad Topic" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.messages({ agent: "Bad Agent" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("messages returns the log including queued-then-dispatched goals", async () => {
    await svc.submitGoal({ goal: "queued" });
    expect(await svc.messages({})).toEqual([]); // queued goals have no message until dispatched
    await svc.dispatchQueued(8);
    expect((await svc.messages({})).map((m) => m.body)).toEqual(["queued"]);
  });

  it("reports validates limit and agent, and lists newest first", async () => {
    await expect(svc.reports({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.reports({ agent: "Bad Agent" })).rejects.toBeInstanceOf(ValidationError);

    const one = await goalTo("a", "1");
    await report("a", [one.message.id]);
    const two = await goalTo("a", "2");
    await report("a", [two.message.id], "failed");
    expect((await svc.reports({ agent: "a" })).map((r) => r.outcome)).toEqual(["failed", "done"]);
  });
});

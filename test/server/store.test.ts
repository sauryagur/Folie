import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import type { Store } from "../../src/server/store";
import { testStore } from "../support/db";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
beforeAll(async () => ({ db, store, reset } = await testStore()));
beforeEach(() => reset());
afterAll(() => db.close());

/** Pretends an agent has been quiet for `seconds`. */
const age = (name: string, seconds: number) =>
  db.query("UPDATE agents SET last_active_at = now() - make_interval(secs => $2) WHERE name = $1", [name, seconds]);

describe("messages", () => {
  it("returns unacked messages oldest first, per recipient", async () => {
    await store.agents.touch("a");
    await store.agents.touch("b");
    const m1 = await store.messages.send({ from: "human", to: "a", body: "one" });
    await store.messages.send({ from: "human", to: "b", body: "other" });
    const m3 = await store.messages.send({ from: "x", to: "a", body: "two" });

    const inbox = await store.messages.unacked("a");
    expect(inbox.map((m) => m.id)).toEqual([m1.id, m3.id]);
    expect(inbox[0]).toMatchObject({ from: "human", to: "a", body: "one", workItemId: null, ackedAt: null });
  });

  it("acks only the requested unacked messages of that recipient", async () => {
    await store.agents.touch("a");
    await store.agents.touch("b");
    const mine = await store.messages.send({ from: "h", to: "a", body: "x" });
    const theirs = await store.messages.send({ from: "h", to: "b", body: "y" });

    const acked = await store.messages.ack("a", [mine.id, theirs.id]);
    expect(acked.map((m) => m.id)).toEqual([mine.id]);
    expect(await store.messages.unacked("a")).toEqual([]);
    expect(await store.messages.unacked("b")).toHaveLength(1);
    // Re-acking is a no-op: ack is not idempotent-success, callers detect it by count.
    expect(await store.messages.ack("a", [mine.id])).toEqual([]);
  });

  it("rejects messages to agents that do not exist", async () => {
    await expect(store.messages.send({ from: "h", to: "ghost", body: "x" })).rejects.toThrow();
  });
});

describe("agents", () => {
  it("touch is idempotent and list reports unread counts", async () => {
    await store.agents.touch("a");
    await store.agents.touch("a");
    await store.agents.touch("b");
    await store.messages.send({ from: "h", to: "a", body: "1" });
    await store.messages.send({ from: "h", to: "a", body: "2" });

    expect(await store.agents.list()).toEqual([
      { name: "a", state: "pending", wakeEpoch: 0, unread: 2, lastActiveAt: expect.any(String) },
      { name: "b", state: "pending", wakeEpoch: 0, unread: 0, lastActiveAt: expect.any(String) },
    ]);
  });

  it("withUnread is the wake demand: agents with any unacked mail, once each", async () => {
    await store.agents.touch("a");
    await store.agents.touch("b");
    await store.messages.send({ from: "h", to: "b", body: "1" });
    const m = await store.messages.send({ from: "h", to: "b", body: "2" });
    expect(await store.agents.withUnread()).toEqual(["b"]);
    await store.messages.ack("b", [m.id - 1, m.id]);
    expect(await store.agents.withUnread()).toEqual([]);
  });

  it("advances wake epoch only on transition into running", async () => {
    await store.agents.touch("a");
    await store.agents.setState("a", "running");
    await store.agents.setState("a", "running");
    expect((await store.agents.list())[0]).toMatchObject({ state: "running", wakeEpoch: 1 });
    await store.agents.setState("a", "suspended");
    await store.agents.setState("a", "running");
    expect((await store.agents.list())[0]).toMatchObject({ state: "running", wakeEpoch: 2 });
  });
});

describe("idle", () => {
  it("lists agents in the state that have been quiet long enough, and only those", async () => {
    for (const n of ["quiet", "fresh", "other-state"]) await store.agents.touch(n);
    for (const n of ["quiet", "fresh"]) await store.agents.setState(n, "running");
    await store.agents.setState("other-state", "suspended");
    await age("quiet", 120);
    await age("other-state", 120);

    expect(await store.agents.idle("running", 60)).toEqual(["quiet"]);
    expect(await store.agents.idle("suspended", 60)).toEqual(["other-state"]);
  });

  it("never counts an agent with unread mail as idle, however long ago it was active", async () => {
    await store.agents.touch("busy");
    await store.agents.setState("busy", "running");
    await store.messages.send({ from: "h", to: "busy", body: "work" });
    await age("busy", 3600);
    expect(await store.agents.idle("running", 60)).toEqual([]);
  });

  it("touch restarts the quiet period", async () => {
    await store.agents.touch("a");
    await store.agents.setState("a", "running");
    await age("a", 3600);
    expect(await store.agents.idle("running", 60)).toEqual(["a"]);
    await store.agents.touch("a");
    expect(await store.agents.idle("running", 60)).toEqual([]);
  });

  it("setState alone does not count as activity", async () => {
    await store.agents.touch("a");
    await age("a", 3600);
    await store.agents.setState("a", "running");
    expect(await store.agents.idle("running", 60)).toEqual(["a"]);
  });
});

describe("work items", () => {
  it("oldestQueued skips assigned items and returns the lowest id", async () => {
    expect(await store.workItems.oldestQueued()).toBeNull();
    const first = await store.workItems.create("first", "queued");
    await store.workItems.create("second", "queued");
    await store.workItems.create("assigned", "assigned");
    expect((await store.workItems.oldestQueued())?.id).toBe(first.id);

    await store.workItems.setState([first.id], "assigned");
    expect((await store.workItems.oldestQueued())?.goal).toBe("second");
  });
});

describe("reports", () => {
  it("links the latest report to a work item through the messages its session consumed", async () => {
    await store.agents.touch("a");
    const item = await store.workItems.create("goal", "assigned");
    const m = await store.messages.send({ from: "human", to: "a", body: "goal", workItemId: item.id });
    expect(await store.workItems.latestReport(item.id)).toBeNull();

    const first = await store.reports.record({ agent: "a", startedAt: new Date().toISOString(), outcome: "failed", summary: "no", messageIds: [m.id] });
    const second = await store.reports.record({ agent: "a", startedAt: new Date().toISOString(), outcome: "done", summary: "yes", messageIds: [m.id] });

    const latest = await store.workItems.latestReport(item.id);
    expect(latest).toMatchObject({ id: second.id, agent: "a", outcome: "done", summary: "yes", messageIds: [m.id] });
    expect(latest!.id).not.toBe(first.id);
  });

  it("does not leak another work item's report", async () => {
    await store.agents.touch("a");
    const one = await store.workItems.create("one", "assigned");
    const two = await store.workItems.create("two", "assigned");
    const m1 = await store.messages.send({ from: "h", to: "a", body: "1", workItemId: one.id });
    await store.messages.send({ from: "h", to: "a", body: "2", workItemId: two.id });
    await store.reports.record({ agent: "a", startedAt: new Date().toISOString(), outcome: "done", summary: "s", messageIds: [m1.id] });
    expect(await store.workItems.latestReport(two.id)).toBeNull();
  });
});

describe("transactions", () => {
  it("roll back every write when the unit of work throws", async () => {
    await expect(
      store.transaction(async (r) => {
        await r.agents.touch("a");
        await r.workItems.create("g", "assigned");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.agents.list()).toEqual([]);
  });
});

describe("topics", () => {
  async function subscribers(topic: string, names: string[]) {
    for (const n of names) {
      await store.agents.touch(n);
      await store.topics.subscribe(topic, n);
    }
  }

  it("publish copies the message to every subscriber except the publisher", async () => {
    await subscribers("news", ["a", "b", "c"]);
    const copies = await store.topics.publish("news", "a", "hello");

    expect(copies.map((m) => m.to)).toEqual(["b", "c"]);
    expect(copies[0]).toMatchObject({ from: "a", body: "hello", topic: "news", workItemId: null, ackedAt: null });
    expect(await store.messages.unacked("a")).toEqual([]);
    expect((await store.messages.unacked("b"))[0]).toMatchObject({ topic: "news", body: "hello" });
    expect(await store.agents.withUnread()).toEqual(["b", "c"]);
  });

  it("a publisher that is not a subscriber reaches everyone", async () => {
    await subscribers("news", ["a", "b"]);
    expect((await store.topics.publish("news", "human", "x")).map((m) => m.to)).toEqual(["a", "b"]);
  });

  it("publishing to a topic nobody listens to delivers nothing and creates no mail", async () => {
    await store.agents.touch("a");
    expect(await store.topics.publish("empty", "a", "x")).toEqual([]);
    expect(await store.agents.withUnread()).toEqual([]);
  });

  it("keeps topics separate", async () => {
    await subscribers("one", ["a"]);
    await subscribers("two", ["b"]);
    await store.topics.publish("one", "human", "only for one");
    expect(await store.agents.withUnread()).toEqual(["a"]);
  });

  it("subscribe is idempotent and unsubscribe stops delivery", async () => {
    await subscribers("news", ["a"]);
    await store.topics.subscribe("news", "a");
    expect(await store.topics.publish("news", "human", "1")).toHaveLength(1);

    await store.topics.unsubscribe("news", "a");
    await store.topics.unsubscribe("news", "a");
    expect(await store.topics.publish("news", "human", "2")).toEqual([]);
  });

  it("only delivers to subscribers present at publish time: nothing is replayed to late joiners", async () => {
    await subscribers("news", ["early"]);
    await store.topics.publish("news", "human", "before");
    await subscribers("news", ["late"]);
    expect(await store.messages.unacked("late")).toEqual([]);
  });

  it("counts delivered mail as activity for recipients", async () => {
    await subscribers("news", ["b"]);
    await store.agents.setState("b", "running");
    await age("b", 3600);
    const [copy] = await store.topics.publish("news", "human", "x");
    await store.messages.ack("b", [copy!.id]);
    expect(await store.agents.idle("running", 60)).toEqual([]);
  });

  it("lists topics with sorted subscribers; a topic with none disappears", async () => {
    await subscribers("zeta", ["b", "a"]);
    await subscribers("alpha", ["c"]);
    expect(await store.topics.list()).toEqual([
      { topic: "alpha", subscribers: ["c"] },
      { topic: "zeta", subscribers: ["a", "b"] },
    ]);
    await store.topics.unsubscribe("alpha", "c");
    expect((await store.topics.list()).map((t) => t.topic)).toEqual(["zeta"]);
  });

  it("refuses a subscription for an agent that does not exist", async () => {
    await expect(store.topics.subscribe("news", "ghost")).rejects.toThrow();
  });
});

describe("message log", () => {
  /** a->b, b->a, a->c on topic "t", human->b: ids ascending in that order. */
  async function seed() {
    for (const n of ["a", "b", "c"]) await store.agents.touch(n);
    const sent = [
      await store.messages.send({ from: "a", to: "b", body: "1" }),
      await store.messages.send({ from: "b", to: "a", body: "2" }),
    ];
    sent.push(...(await store.topics.publish("t", "a", "3")));
    await store.topics.subscribe("t", "c");
    sent.push(...(await store.topics.publish("t", "a", "4")));
    sent.push(await store.messages.send({ from: "human", to: "b", body: "5" }));
    return sent;
  }

  it("returns everything, acked or not, oldest first", async () => {
    const [first] = await seed();
    await store.messages.ack("b", [first!.id]);
    const all = await store.messages.list({});
    expect(all.map((m) => m.body)).toEqual(["1", "2", "4", "5"]);
    expect(all[0]!.ackedAt).not.toBeNull();
  });

  it("without a cursor returns the newest `limit`, still oldest first", async () => {
    await seed();
    expect((await store.messages.list({ limit: 2 })).map((m) => m.body)).toEqual(["4", "5"]);
  });

  it("with a cursor returns what came after it, so a poller never misses or repeats a message", async () => {
    const sent = await seed();
    const page = await store.messages.list({ after: sent[1]!.id, limit: 100 });
    expect(page.map((m) => m.body)).toEqual(["4", "5"]);
    expect(await store.messages.list({ after: page.at(-1)!.id })).toEqual([]);
    const first = await store.messages.list({ after: 0, limit: 2 });
    expect(first.map((m) => m.body)).toEqual(["1", "2"]);
  });

  it("filters by topic and by agent (either end of the message)", async () => {
    await seed();
    expect((await store.messages.list({ topic: "t" })).map((m) => m.body)).toEqual(["4"]);
    expect((await store.messages.list({ agent: "a" })).map((m) => m.body)).toEqual(["1", "2", "4"]);
    expect((await store.messages.list({ agent: "c" })).map((m) => m.body)).toEqual(["4"]);
    expect((await store.messages.list({ agent: "b", topic: "t" }))).toEqual([]);
  });

  it("clamps limit to 1..500", async () => {
    await seed();
    expect(await store.messages.list({ limit: 0 })).toHaveLength(1);
    expect(await store.messages.list({ limit: 100000 })).toHaveLength(4);
  });
});

describe("report list", () => {
  async function report(agent: string, summary: string) {
    await store.agents.touch(agent);
    const m = await store.messages.send({ from: "h", to: agent, body: "x" });
    return store.reports.record({ agent, startedAt: new Date().toISOString(), outcome: "done", summary, messageIds: [m.id] });
  }

  it("lists newest first, optionally for one agent, capped by limit", async () => {
    await report("a", "a1");
    await report("b", "b1");
    await report("a", "a2");
    expect((await store.reports.list({})).map((r) => r.summary)).toEqual(["a2", "b1", "a1"]);
    expect((await store.reports.list({ agent: "a" })).map((r) => r.summary)).toEqual(["a2", "a1"]);
    expect((await store.reports.list({ limit: 1 })).map((r) => r.summary)).toEqual(["a2"]);
    expect(await store.reports.list({ agent: "nobody" })).toEqual([]);
  });
});

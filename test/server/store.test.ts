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
      { name: "a", state: "pending", wakeEpoch: 0, unread: 2 },
      { name: "b", state: "pending", wakeEpoch: 0, unread: 0 },
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

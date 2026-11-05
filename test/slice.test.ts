// The slice, wired for real except ax and the LLM: goal -> queue -> pool -> wake -> session -> report -> quiet -> suspend.
import { afterAll, beforeEach, expect, it } from "vitest";
import type { Runtime } from "../src/agent/runtime";
import { echoRuntime } from "../src/agent/runtimes/echo";
import { startCluster } from "./support/cluster";
import type { FakeAx } from "./support/fakes";

const cluster = await startCluster();
const { client, tick, runAgents, age } = cluster;
let ax: FakeAx;
beforeEach(async () => void ({ ax } = await cluster.reset()));
afterAll(() => cluster.close());

it("a submitted goal waits in the queue, then wakes a pool agent that works it and reports", async () => {
  const { workItem, message } = await client.submitGoal({
    goal: "implement the PRD",
  });
  expect(message).toBeNull();
  expect(ax.tasks.size).toBe(0);

  await tick();
  expect([...ax.tasks.keys()]).toEqual(["folie/agent-1"]);

  await runAgents(() => echoRuntime);

  const view = await client.workItem(workItem.id);
  expect(view.workItem.state).toBe("done");
  expect(view.report).toMatchObject({
    agent: "agent-1",
    outcome: "done",
    summary: "echo: [human] implement the PRD",
  });
  expect((await client.agents())[0]).toMatchObject({
    name: "agent-1",
    state: "running",
    wakeEpoch: 1,
    unread: 0,
  });

  // Mail drained: nothing left to wake.
  ax.calls.length = 0;
  await tick();
  expect(ax.calls).toEqual([]);
});

it("the pool grows to its ceiling under load, queues the overflow, and drains it as agents free up", async () => {
  const ids = [];
  for (const goal of ["one", "two", "three"])
    ids.push((await client.submitGoal({ goal })).workItem.id);

  await tick();
  expect([...ax.tasks.keys()].sort()).toEqual([
    "folie/agent-1",
    "folie/agent-2",
  ]);
  expect((await client.workItem(ids[2]!)).workItem.state).toBe("queued");

  await runAgents(() => echoRuntime);
  await tick();
  await runAgents(() => echoRuntime);

  for (const id of ids)
    expect((await client.workItem(id)).workItem.state).toBe("done");
  expect([...ax.tasks.keys()].sort()).toEqual([
    "folie/agent-1",
    "folie/agent-2",
  ]);
});

it("emergence: an agent delegating by message wakes a peer that did not exist", async () => {
  await client.registerAgent("lead");
  await client.registerAgent("worker");
  const { workItem } = await client.submitGoal({
    goal: "split this up",
    to: "lead",
  });
  const delegating: Runtime = {
    run: async () => {
      const ac = await cluster.agentClientFor("lead");
      await ac.send({
        from: "lead",
        to: "worker",
        body: "take the second half",
      });
      return { outcome: "done", summary: "delegated" };
    },
  };

  await tick();
  await runAgents((name) => (name === "lead" ? delegating : echoRuntime));
  expect([...ax.tasks.keys()]).toEqual(["folie/lead"]);

  await tick();
  expect([...ax.tasks.keys()].sort()).toEqual(["folie/lead", "folie/worker"]);
  await runAgents(() => echoRuntime);

  expect((await client.workItem(workItem.id)).workItem.state).toBe("done");
  expect(await client.inbox("worker")).toEqual([]);
});

it("a topic publish wakes subscribers that have never run, and reaches them again after they are suspended", async () => {
  await client.registerAgent("watch-1");
  await client.registerAgent("watch-2");
  await client.subscribe("alerts", { agent: "watch-1" });
  await client.subscribe("alerts", { agent: "watch-2" });
  expect(ax.tasks.size).toBe(0); // subscribing alone wakes nobody

  expect(
    await client.publish("alerts", { from: "human", body: "disk full" }),
  ).toEqual({ delivered: 2 });
  await tick();
  expect([...ax.tasks.keys()].sort()).toEqual([
    "folie/watch-1",
    "folie/watch-2",
  ]);
  await runAgents(() => echoRuntime);
  expect(await client.inbox("watch-1")).toEqual([]);
  expect(await client.inbox("watch-2")).toEqual([]);

  // Delivery is durable, not live: a suspended subscriber gets the next publish and wakes with it.
  await age("watch-1", 120);
  await tick();
  expect(ax.tasks.get("folie/watch-1")!.phase).toBe("Suspended");
  const task = ax.tasks.get("folie/watch-1");
  await client.publish("alerts", { from: "human", body: "disk still full" });
  await tick();
  expect(ax.tasks.get("folie/watch-1")).toBe(task);
  expect(ax.tasks.get("folie/watch-1")!.phase).toBe("Running");
  expect(await client.inbox("watch-1")).toMatchObject([
    { topic: "alerts", body: "disk still full" },
  ]);
});

it("an agent publishing from a session wakes the other subscribers, not itself", async () => {
  await client.registerAgent("lead");
  await client.registerAgent("worker");
  await client.subscribe("alerts", { agent: "lead" });
  await client.subscribe("alerts", { agent: "worker" });
  await client.submitGoal({ goal: "announce", to: "lead" });
  const announcing: Runtime = {
    run: async () => {
      const ac = await cluster.agentClientFor("lead");
      await ac.publish("alerts", { from: "lead", body: "heads up" });
      return { outcome: "done", summary: "announced" };
    },
  };

  await tick();
  await runAgents((name) => (name === "lead" ? announcing : echoRuntime));
  expect(await client.inbox("lead")).toEqual([]);

  await tick();
  expect([...ax.tasks.keys()].sort()).toEqual(["folie/lead", "folie/worker"]);
  expect(await client.inbox("worker")).toMatchObject([
    { from: "lead", topic: "alerts", body: "heads up" },
  ]);
});

it("a failing session parks the work item as blocked and is not retried", async () => {
  const { workItem } = await client.submitGoal({ goal: "impossible" });
  await tick();
  let runs = 0;
  const failing: Runtime = {
    run: async () => (runs++, Promise.reject(new Error("tests do not pass"))),
  };

  await runAgents(() => failing);
  await runAgents(() => failing);

  expect(runs).toBe(1);
  const view = await client.workItem(workItem.id);
  expect(view.workItem.state).toBe("blocked");
  expect(view.report).toMatchObject({
    outcome: "failed",
    summary: "tests do not pass",
  });
});

it("lifecycle: quiet agents are suspended, resumed by new mail with the same task, and retired after long quiet", async () => {
  await client.submitGoal({ goal: "first" });
  await tick();
  await runAgents(() => echoRuntime);
  expect(ax.tasks.get("folie/agent-1")!.phase).toBe("Running");

  // Just worked: not quiet yet.
  await tick();
  expect(ax.tasks.get("folie/agent-1")!.phase).toBe("Running");

  await age("agent-1", 120);
  await tick();
  expect(ax.tasks.get("folie/agent-1")!.phase).toBe("Suspended");
  expect((await client.agents())[0]).toMatchObject({ state: "suspended" });

  // New work resumes the very same task: its /workspace (and so its memory) was never deleted.
  const taskBefore = ax.tasks.get("folie/agent-1");
  const { workItem } = await client.submitGoal({ goal: "second" });
  await tick();
  expect(ax.tasks.get("folie/agent-1")).toBe(taskBefore);
  expect(ax.tasks.get("folie/agent-1")!.phase).toBe("Running");
  await runAgents(() => echoRuntime);
  expect((await client.workItem(workItem.id)).workItem.state).toBe("done");
  expect((await client.agents())[0]).toMatchObject({ wakeEpoch: 2 });

  // Quiet again, suspended, then quiet far longer: retired, task deleted.
  await age("agent-1", 120);
  await tick();
  await age("agent-1", 3600);
  await tick();
  expect(ax.tasks.has("folie/agent-1")).toBe(false);
  expect((await client.agents())[0]).toMatchObject({ state: "retired" });

  // Work for a retired agent starts a fresh task rather than failing.
  const { workItem: third } = await client.submitGoal({ goal: "third" });
  await tick();
  expect(ax.tasks.get("folie/agent-1")!.phase).toBe("Running");
  await runAgents(() => echoRuntime);
  expect((await client.workItem(third.id)).workItem.state).toBe("done");
});

it("operator steering over HTTP: suspend, resume and the delete kill switch", async () => {
  await client.registerAgent("a");
  await client.submitGoal({ goal: "work", to: "a" });
  await tick();
  await runAgents(() => echoRuntime);

  expect(await client.agentOp("suspend", "a")).toEqual({
    agent: "a",
    state: "suspended",
  });
  expect(ax.tasks.get("folie/a")!.phase).toBe("Suspended");
  await tick(); // nothing wakes it: no mail
  expect(ax.tasks.get("folie/a")!.phase).toBe("Suspended");

  // Resuming by hand restarts the quiet period, so the sweep does not suspend it straight back.
  await age("a", 3600);
  await client.agentOp("resume", "a");
  await tick();
  expect(ax.tasks.get("folie/a")!.phase).toBe("Running");
  expect((await client.agents())[0]).toMatchObject({ state: "running" });

  expect(await client.agentOp("delete", "a")).toEqual({
    agent: "a",
    state: "retired",
  });
  expect(ax.tasks.has("folie/a")).toBe(false);

  // Mail to a deleted agent starts a fresh task: deletion is retirement, not a ban.
  await client.send({ from: "human", to: "a", body: "back again" });
  await tick();
  expect(ax.tasks.get("folie/a")!.phase).toBe("Running");

  await expect(client.agentOp("suspend", "never-existed")).rejects.toThrow(
    /404/,
  );
});

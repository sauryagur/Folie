import { beforeEach, describe, expect, it } from "vitest";
import { Controller, type ControllerConfig } from "../../src/server/controller";
import { NotFoundError, ValidationError } from "../../src/server/errors";
import { FakeAx, FakeEgress, silent } from "../support/fakes";

const cfg: ControllerConfig = {
  atespace: "folie",
  image: "registry/agent@sha256:abc",
  command: ["/usr/local/bin/folie-agent"],
  env: { FOLIE_SERVER_URL: "http://server", ANTHROPIC_API_KEY: "k" },
  suspendAfterSec: 60,
  deleteAfterSec: 600,
};

class FakeAgents {
  unread: string[] = [];
  idleByState = new Map<string, string[]>();
  idleQueries: [string, number][] = [];
  states = new Map<string, string>();
  withUnread = async () => this.unread;
  idle = async (state: string, seconds: number) => (this.idleQueries.push([state, seconds]), this.idleByState.get(state) ?? []);
  setState = async (name: string, state: string) => void this.states.set(name, state);
  touched: string[] = [];
  touch = async (name: string) => void this.touched.push(name);
}

let ax: FakeAx;
let egress: FakeEgress;
let agents: FakeAgents;
let controller: Controller;
beforeEach(() => {
  ax = new FakeAx();
  egress = new FakeEgress(ax.calls);
  agents = new FakeAgents();
  controller = new Controller(ax, egress, agents, cfg, silent);
});

/** A task that exists in ax in the given phase, as if the controller had made it earlier. */
async function taskIn(name: string, phase: string) {
  await ax.createTask({ atespace: "folie", name, image: "i", command: [], env: {} });
  ax.tasks.get(`folie/${name}`)!.phase = phase;
  ax.calls.length = 0;
}

describe("wake demand", () => {
  it("creates, grants egress, then resumes the task of an agent that has mail but no task", async () => {
    agents.unread = ["agent-1"];
    await controller.reconcileOnce();

    // Egress must land before resume: a sandbox that starts first has no DNS and never reaches the server.
    expect(ax.calls).toEqual(["create agent-1", "egress folie/agent-1", "resume agent-1"]);
    const { spec, phase } = ax.tasks.get("folie/agent-1")!;
    expect(phase).toBe("Running");
    expect(spec).toMatchObject({ image: cfg.image, command: cfg.command });
    expect(spec.env).toEqual({ FOLIE_SERVER_URL: "http://server", ANTHROPIC_API_KEY: "k", FOLIE_AGENT: "agent-1" });
    expect(agents.states.get("agent-1")).toBe("running");
  });

  it("grants egress to the actor ax reports, not to the task name", async () => {
    agents.unread = ["a"];
    const create = ax.createTask.bind(ax);
    ax.createTask = async (spec) => {
      await create(spec);
      ax.tasks.get("folie/a")!.actor = "actor-xyz";
    };
    await controller.reconcileOnce();
    expect(ax.calls).toContain("egress folie/actor-xyz");
  });

  it("resumes a suspended task without recreating it (memory lives in its workspace)", async () => {
    await taskIn("a", "Suspended");
    agents.unread = ["a"];
    await controller.reconcileOnce();
    expect(ax.calls).toEqual(["egress folie/a", "resume a"]);
  });

  it("does not resume an agent whose egress grant failed, and retries next pass", async () => {
    agents.unread = ["a"];
    egress.failFor.add("a");
    await controller.reconcileOnce();
    expect(ax.tasks.get("folie/a")?.phase).toBe("Suspended");
    expect(agents.states.has("a")).toBe(false);

    egress.failFor.clear();
    await controller.reconcileOnce();
    expect(ax.tasks.get("folie/a")?.phase).toBe("Running");
    expect(ax.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("leaves a running agent alone, so reconciling is idempotent", async () => {
    await taskIn("a", "Running");
    agents.unread = ["a"];
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
  });

  it("does not touch agents without mail", async () => {
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
  });

  it.each(["Failed", "Resuming"])("does not wake a task in phase %s", async (phase) => {
    await taskIn("a", phase);
    agents.unread = ["a"];
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
  });

  it("keeps waking the others when one agent fails", async () => {
    ax.failFor.add("bad");
    agents.unread = ["bad", "good"];
    await controller.reconcileOnce();

    expect(ax.tasks.get("folie/good")?.phase).toBe("Running");
    expect(agents.states.has("bad")).toBe(false);
  });

  it("scopes tasks and grants to the configured atespace", async () => {
    agents.unread = ["a"];
    await new Controller(ax, egress, agents, { ...cfg, atespace: "other" }, silent).reconcileOnce();
    expect([...ax.tasks.keys()]).toEqual(["other/a"]);
    expect(ax.calls).toContain("egress other/a");
  });
});

describe("idle sweep: suspend", () => {
  it("checkpoints a quiet running agent, using the configured quiet period", async () => {
    await taskIn("a", "Running");
    agents.idleByState.set("running", ["a"]);
    await controller.reconcileOnce();

    expect(ax.calls).toEqual(["suspend a"]);
    expect(agents.states.get("a")).toBe("suspended");
    expect(agents.idleQueries).toContainEqual(["running", 60]);
  });

  it("only records the state when the task is already suspended (an operator got there first)", async () => {
    await taskIn("a", "Suspended");
    agents.idleByState.set("running", ["a"]);
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
    expect(agents.states.get("a")).toBe("suspended");
  });

  it("marks an agent retired when its task has vanished", async () => {
    agents.idleByState.set("running", ["ghost"]);
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
    expect(agents.states.get("ghost")).toBe("retired");
  });

  it("deletes a dead (Failed) quiet agent rather than suspending it", async () => {
    await taskIn("a", "Failed");
    agents.idleByState.set("running", ["a"]);
    await controller.reconcileOnce();
    expect(ax.calls).toEqual(["delete a"]);
    expect(agents.states.get("a")).toBe("retired");
  });

  it("leaves a task in a transitional phase for the next pass", async () => {
    await taskIn("a", "Resuming");
    agents.idleByState.set("running", ["a"]);
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
    expect(agents.states.has("a")).toBe(false);
  });

  it("does not wake and suspend the same agent in one pass: only quiet agents are suspended", async () => {
    await taskIn("a", "Suspended");
    agents.unread = ["a"];
    await controller.reconcileOnce(); // idle() reports nobody, as the real query excludes agents with mail
    expect(ax.calls).toEqual(["egress folie/a", "resume a"]);
  });
});

describe("operator ops", () => {
  it("suspend checkpoints a running agent and records it", async () => {
    await taskIn("a", "Running");
    expect(await controller.run("suspend", "a")).toEqual({ agent: "a", state: "suspended" });
    expect(ax.calls).toEqual(["suspend a"]);
    expect(agents.states.get("a")).toBe("suspended");
  });

  it("suspend of an already suspended agent is a no-op that fixes the record", async () => {
    await taskIn("a", "Suspended");
    await controller.run("suspend", "a");
    expect(ax.calls).toEqual([]);
    expect(agents.states.get("a")).toBe("suspended");
  });

  it("suspend refuses an agent with no task (404) or a task in some other phase (400)", async () => {
    await expect(controller.run("suspend", "ghost")).rejects.toBeInstanceOf(NotFoundError);
    await taskIn("a", "Failed");
    await expect(controller.run("suspend", "a")).rejects.toBeInstanceOf(ValidationError);
    expect(ax.calls).toEqual([]);
  });

  it("resume restarts the quiet period, grants egress and resumes, even with no mail", async () => {
    await taskIn("a", "Suspended");
    expect(await controller.run("resume", "a")).toEqual({ agent: "a", state: "running" });
    expect(agents.touched).toEqual(["a"]);
    expect(ax.calls).toEqual(["egress folie/a", "resume a"]);
  });

  it("resume creates the task for an agent that has none", async () => {
    await controller.run("resume", "fresh");
    expect(ax.calls).toEqual(["create fresh", "egress folie/fresh", "resume fresh"]);
  });

  it("delete is the kill switch: it destroys even a running task", async () => {
    await taskIn("a", "Running");
    expect(await controller.run("delete", "a")).toEqual({ agent: "a", state: "retired" });
    expect(ax.calls).toEqual(["delete a"]);
    expect(ax.tasks.has("folie/a")).toBe(false);
    expect(agents.states.get("a")).toBe("retired");
  });

  it("delete of an agent with no task still records it retired, so repeating it is safe", async () => {
    await controller.run("delete", "ghost");
    expect(ax.calls).toEqual([]);
    expect(agents.states.get("ghost")).toBe("retired");
  });

  it("rejects a malformed agent name before touching ax", async () => {
    await expect(controller.run("delete", "Bad Name")).rejects.toBeInstanceOf(ValidationError);
    expect(ax.calls).toEqual([]);
  });
});

describe("idle sweep: retire", () => {
  it("deletes a long-quiet suspended agent, using the longer horizon", async () => {
    await taskIn("a", "Suspended");
    agents.idleByState.set("suspended", ["a"]);
    await controller.reconcileOnce();

    expect(ax.calls).toEqual(["delete a"]);
    expect(agents.states.get("a")).toBe("retired");
    expect(agents.idleQueries).toContainEqual(["suspended", 600]);
  });

  it("never deletes a task that is running, whatever the database believes", async () => {
    await taskIn("a", "Running");
    agents.idleByState.set("suspended", ["a"]);
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
    expect(agents.states.has("a")).toBe(false);
  });

  it("marks retired without calling ax when the task is already gone", async () => {
    agents.idleByState.set("suspended", ["gone"]);
    await controller.reconcileOnce();
    expect(ax.calls).toEqual([]);
    expect(agents.states.get("gone")).toBe("retired");
  });

  it("retired agents that get mail again come back as a fresh task", async () => {
    await taskIn("a", "Suspended");
    agents.idleByState.set("suspended", ["a"]);
    await controller.reconcileOnce();
    agents.idleByState.clear();
    ax.calls.length = 0;

    agents.unread = ["a"];
    await controller.reconcileOnce();
    expect(ax.calls).toEqual(["create a", "egress folie/a", "resume a"]);
  });

  it("keeps sweeping the others when one deletion fails", async () => {
    await taskIn("bad", "Suspended");
    await taskIn("good", "Suspended");
    agents.idleByState.set("suspended", ["bad", "good"]);
    const del = ax.deleteTask.bind(ax);
    ax.deleteTask = async (a, n) => (n === "bad" ? Promise.reject(new Error("ax down")) : del(a, n));
    await controller.reconcileOnce();
    expect(agents.states.get("good")).toBe("retired");
    expect(agents.states.has("bad")).toBe(false);
  });
});

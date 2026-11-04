import { describe, expect, it } from "vitest";
import { execute, parseCommand, type CommandApi } from "../../src/tui/commands";

const parse = (s: string, selected: string | null = "agent-1") => parseCommand(s, selected);

describe("parseCommand", () => {
  it("accepts an optional leading colon and any spacing", () => {
    expect(parse(":  submit   build   it ")).toEqual({ kind: "submit", goal: "build it", to: undefined });
  });

  it("submit: unaddressed goals queue, @agent goals go straight to that agent", () => {
    expect(parse("submit do it")).toEqual({ kind: "submit", goal: "do it", to: undefined });
    expect(parse("submit @lead do it")).toEqual({ kind: "submit", goal: "do it", to: "lead" });
    expect(parse("submit @lead")).toMatchObject({ kind: "error" });
    expect(parse("submit")).toMatchObject({ kind: "error" });
  });

  it("send defaults to the selected agent and needs a target and text", () => {
    expect(parse("send hello there")).toEqual({ kind: "send", to: "agent-1", body: "hello there" });
    expect(parse("send @bob hello")).toEqual({ kind: "send", to: "bob", body: "hello" });
    expect(parse("send hello", null)).toMatchObject({ kind: "error", message: expect.stringContaining("no agent selected") });
    expect(parse("send @bob")).toMatchObject({ kind: "error" });
    expect(parse("send")).toMatchObject({ kind: "error" });
  });

  it("a lone @ is not an agent", () => {
    expect(parse("send @ hi")).toEqual({ kind: "send", to: "agent-1", body: "@ hi" });
  });

  it("publish needs a topic and text", () => {
    expect(parse("publish news v2 is out")).toEqual({ kind: "publish", topic: "news", body: "v2 is out" });
    expect(parse("publish news")).toMatchObject({ kind: "error" });
  });

  it("subscribe and unsubscribe default the agent to the selection", () => {
    expect(parse("subscribe news")).toEqual({ kind: "subscribe", topic: "news", agent: "agent-1" });
    expect(parse("unsubscribe news bob")).toEqual({ kind: "unsubscribe", topic: "news", agent: "bob" });
    expect(parse("subscribe")).toMatchObject({ kind: "error" });
    expect(parse("subscribe news", null)).toMatchObject({ kind: "error" });
  });

  it.each(["suspend", "resume", "delete"] as const)("%s targets the selection or a named agent", (op) => {
    expect(parse(op)).toEqual({ kind: "op", op, agent: "agent-1" });
    expect(parse(`${op} bob`)).toEqual({ kind: "op", op, agent: "bob" });
    expect(parse(op, null)).toMatchObject({ kind: "error" });
  });

  it("view takes only known views", () => {
    expect(parse("view reports")).toEqual({ kind: "view", view: "reports" });
    expect(parse("view nonsense")).toMatchObject({ kind: "error" });
    expect(parse("view")).toMatchObject({ kind: "error" });
  });

  it("help, quit and their aliases", () => {
    expect(parse("help")).toEqual({ kind: "help" });
    expect(parse("?")).toEqual({ kind: "help" });
    for (const q of ["quit", "q", "exit"]) expect(parse(q)).toEqual({ kind: "quit" });
  });

  it("reports empty and unknown input as errors the status line can show", () => {
    expect(parse("")).toMatchObject({ kind: "error" });
    expect(parse("   ")).toMatchObject({ kind: "error" });
    expect(parse("frobnicate")).toMatchObject({ kind: "error", message: expect.stringContaining("frobnicate") });
  });
});

describe("execute", () => {
  function fakeApi() {
    const calls: string[] = [];
    const api: CommandApi = {
      submitGoal: async (r) => {
        calls.push(`submit ${r.to ?? "-"} ${r.goal}`);
        return {
          workItem: { id: 9, goal: r.goal, state: r.to ? "assigned" : "queued", createdAt: "" },
          message: r.to ? { id: 1, from: "human", to: r.to, body: r.goal, workItemId: 9, topic: null, createdAt: "", ackedAt: null } : null,
        };
      },
      send: async (r) => (calls.push(`send ${r.from}>${r.to} ${r.body}`), { id: 5, ...r, workItemId: null, topic: null, createdAt: "", ackedAt: null }),
      publish: async (t, r) => (calls.push(`publish ${t} ${r.from} ${r.body}`), { delivered: 2 }),
      subscribe: async (t, r) => (calls.push(`subscribe ${t} ${r.agent}`), { topic: t, agent: r.agent }),
      unsubscribe: async (t, r) => (calls.push(`unsubscribe ${t} ${r.agent}`), { topic: t, agent: r.agent }),
      agentOp: async (op, agent) => (calls.push(`${op} ${agent}`), { agent, state: op === "delete" ? "retired" : "running" }),
    };
    return { api, calls };
  }

  it("submit reports whether the goal was queued or sent", async () => {
    const { api } = fakeApi();
    expect(await execute({ kind: "submit", goal: "g" }, api)).toBe("work item #9 queued");
    expect(await execute({ kind: "submit", goal: "g", to: "lead" }, api)).toBe("work item #9 sent to lead");
  });

  it("sends and publishes as the human", async () => {
    const { api, calls } = fakeApi();
    expect(await execute({ kind: "send", to: "a", body: "hi" }, api)).toBe("message #5 sent to a");
    expect(await execute({ kind: "publish", topic: "news", body: "x" }, api)).toBe("delivered to 2 subscriber(s) of news");
    expect(calls).toEqual(["send human>a hi", "publish news human x"]);
  });

  it("subscribes, unsubscribes and steers", async () => {
    const { api, calls } = fakeApi();
    expect(await execute({ kind: "subscribe", topic: "t", agent: "a" }, api)).toBe("a subscribed to t");
    expect(await execute({ kind: "unsubscribe", topic: "t", agent: "a" }, api)).toBe("a unsubscribed from t");
    expect(await execute({ kind: "op", op: "delete", agent: "a" }, api)).toBe("a: retired");
    expect(calls).toEqual(["subscribe t a", "unsubscribe t a", "delete a"]);
  });

  it("lets server errors through for the caller to show", async () => {
    const { api } = fakeApi();
    api.agentOp = async () => Promise.reject(new Error("404 ghost has no task"));
    await expect(execute({ kind: "op", op: "suspend", agent: "ghost" }, api)).rejects.toThrow("404 ghost has no task");
  });
});

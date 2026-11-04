import { describe, expect, it } from "vitest";
import { agents, formatWorkItem, status, submit, type Api } from "../../src/cli/commands";
import type { SubmitGoalRequest, WorkItemState, WorkItemView } from "../../src/shared/types";

const view = (state: WorkItemState, withReport = false): WorkItemView => ({
  workItem: { id: 5, goal: "g", state, createdAt: "" },
  report: withReport ? { id: 1, agent: "agent-1", outcome: state === "done" ? "done" : "failed", summary: "sum", messageIds: [1], createdAt: "" } : null,
});

/** Fake API whose work item walks through the given states, one per poll. */
function fakeApi(states: WorkItemView[]) {
  const submitted: SubmitGoalRequest[] = [];
  let polls = 0;
  const api: Api = {
    submitGoal: async (r) => {
      submitted.push(r);
      const message = r.to ? { id: 1, from: "human", to: r.to, body: r.goal, workItemId: 5, createdAt: "", ackedAt: null } : null;
      return { workItem: view("assigned").workItem, message };
    },
    workItem: async () => states[Math.min(polls++, states.length - 1)]!,
    agents: async () => [],
  };
  return { api, submitted, polls: () => polls };
}

const collect = () => {
  const lines: string[] = [];
  // console.log is the real sink: it prints every extra argument, so a call like forEach(out) must fail here.
  const out = (...args: string[]) => {
    expect(args).toHaveLength(1);
    lines.push(args[0]!);
  };
  return { lines, out };
};

describe("submit", () => {
  it("joins the words into one goal and targets --to", async () => {
    const { api, submitted } = fakeApi([view("assigned")]);
    const { out, lines } = collect();
    expect(await submit(api, ["--to", "bob", "write", "the", "docs"], out)).toBe(0);
    expect(submitted).toEqual([{ goal: "write the docs", to: "bob" }]);
    expect(lines).toEqual(["submitted work item #5 to bob"]);
  });

  it("requires a goal", async () => {
    await expect(submit(fakeApi([]).api, [], () => {})).rejects.toThrow(/usage/);
  });

  it("says the goal is queued when no agent is named", async () => {
    const { out, lines } = collect();
    await submit(fakeApi([view("queued")]).api, ["anything"], out);
    expect(lines).toEqual(["queued work item #5"]);
  });

  it("--wait polls until done, prints the report and exits 0", async () => {
    const { api, polls } = fakeApi([view("assigned"), view("assigned"), view("done", true)]);
    const { out, lines } = collect();
    expect(await submit(api, ["go", "--wait"], out, { pollMs: 0 })).toBe(0);
    expect(polls()).toBe(3);
    expect(lines.at(-1)).toBe("report (agent-1, done): sum");
  });

  it("--wait exits 1 when the work parks in blocked", async () => {
    const { api } = fakeApi([view("blocked", true)]);
    const { out, lines } = collect();
    expect(await submit(api, ["go", "--wait"], out, { pollMs: 0 })).toBe(1);
    expect(lines[1]).toBe("work item #5: blocked");
  });

  it("--wait gives up after the timeout", async () => {
    const { api } = fakeApi([view("assigned")]);
    await expect(submit(api, ["go", "--wait", "--timeout", "0"], () => {}, { pollMs: 0 })).rejects.toThrow(/still assigned after 0s/);
  });
});

describe("status", () => {
  it("prints the work item and its report", async () => {
    const { out, lines } = collect();
    await status(fakeApi([view("done", true)]).api, ["5"], out);
    expect(lines).toEqual(["work item #5: done", "goal: g", "report (agent-1, done): sum"]);
  });

  it("rejects a non-numeric id", async () => {
    await expect(status(fakeApi([]).api, ["abc"], () => {})).rejects.toThrow(/usage/);
  });
});

describe("agents", () => {
  it("says so when the swarm is empty and lists agents otherwise", async () => {
    const { out, lines } = collect();
    const api = { ...fakeApi([]).api };
    await agents(api, [], out);
    expect(lines).toEqual(["no agents yet"]);

    lines.length = 0;
    await agents({ ...api, agents: async () => [{ name: "a", state: "running", wakeEpoch: 2, unread: 1 }] }, [], out);
    expect(lines[0]).toMatch(/^a\s+running\s+unread=1 wakes=2$/);
  });
});

describe("formatWorkItem", () => {
  it("omits the report line until there is one", () => {
    expect(formatWorkItem(view("assigned"))).toEqual(["work item #5: assigned", "goal: g"]);
  });
});

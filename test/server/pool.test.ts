import { describe, expect, it } from "vitest";
import { choosePoolAgent } from "../../src/server/pool";
import type { AgentInfo } from "../../src/shared/types";

const agent = (name: string, state: string, unread = 0): AgentInfo => ({
  name,
  state,
  wakeEpoch: 0,
  unread,
  lastActiveAt: "",
});

describe("choosePoolAgent", () => {
  it("starts the pool with agent-1", () => {
    expect(choosePoolAgent([], 4)).toBe("agent-1");
  });

  it("prefers an idle running agent, then a suspended one, then a retired one", () => {
    const pool = [
      agent("agent-1", "retired"),
      agent("agent-2", "suspended"),
      agent("agent-3", "running"),
    ];
    expect(choosePoolAgent(pool, 8)).toBe("agent-3");
    expect(
      choosePoolAgent(
        pool.filter((a) => a.state !== "running"),
        8,
      ),
    ).toBe("agent-2");
    expect(choosePoolAgent([agent("agent-1", "retired")], 8)).toBe("agent-1");
  });

  it("breaks ties by pool number, numerically (agent-2 before agent-10)", () => {
    expect(
      choosePoolAgent(
        [agent("agent-10", "running"), agent("agent-2", "running")],
        20,
      ),
    ).toBe("agent-2");
  });

  it("grows the pool when every agent has mail, up to the cap", () => {
    const busy = [
      agent("agent-1", "running", 1),
      agent("agent-2", "running", 3),
    ];
    expect(choosePoolAgent(busy, 3)).toBe("agent-3");
    expect(choosePoolAgent(busy, 2)).toBeNull();
  });

  it("names the new agent with the lowest free number", () => {
    expect(
      choosePoolAgent(
        [agent("agent-1", "running", 1), agent("agent-3", "running", 1)],
        8,
      ),
    ).toBe("agent-2");
  });

  it("does not count retired agents against the cap", () => {
    const pool = [
      agent("agent-1", "running", 1),
      agent("agent-2", "retired", 1),
    ];
    expect(choosePoolAgent(pool, 2)).toBe("agent-3");
  });

  it("never drafts agents addressed by name into the pool", () => {
    expect(
      choosePoolAgent(
        [agent("lead", "running"), agent("worker", "running")],
        4,
      ),
    ).toBe("agent-1");
    expect(choosePoolAgent([agent("lead", "running")], 1)).toBe("agent-1");
  });
});

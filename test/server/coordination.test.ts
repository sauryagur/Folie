// Coordination: team formation/dissolution with budget return; dedup/runaway quotas reject excess.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import type { Store } from "../../src/server/store";
import { testStore } from "../support/db";
import {
  activateTeam,
  checkQuota,
  dissolveTeam,
  formTeam,
  joinTeam,
  nominate,
  nextEscalation,
  recordDissent,
  setResponsibility,
  MAX_TEAM_SIZE,
  TEAM_TRANSITIONS,
} from "../../src/server/teams";

let db: Database;
let store: Store;
let reset: () => Promise<void>;

beforeAll(async () => ({ db, store, reset } = await testStore()));
beforeEach(async () => {
  await reset();
  await db.query(
    "TRUNCATE teams, team_members, capabilities, agent_capabilities, coordination_proposals, negotiation_dissents RESTART IDENTITY CASCADE",
  );
});
afterAll(() => db.close());

describe("team lifecycle", () => {
  it("forms, activates and dissolves with budget return", async () => {
    await store.agents.register("convener");
    await store.agents.register("alice");
    await store.agents.register("bob");
    const root = await store.budgets.create({
      name: "goal:1",
      limitAmount: 100,
      dim: "usd",
    });
    const team = await formTeam(store, {
      name: "alpha",
      scopeKind: "goal",
      scopeId: "goal:1",
      purpose: "build",
      convener: "convener",
      budgetId: root.id,
      budgetAsk: 40,
      minMembers: 2,
    });
    expect(team.status).toBe("forming");
    expect(team.budgetId).not.toBeNull();

    await joinTeam(store, team.id, "alice", "dev", "frontend");
    await joinTeam(store, team.id, "bob", "dev", "backend");
    await setResponsibility(store, team.id, "alice", "frontend + tests");
    const members = await store.teams.members(team.id);
    expect(members.find((m) => m.agent === "alice")?.responsibilities).toBe(
      "frontend + tests",
    );

    const active = await activateTeam(store, team.id);
    expect(active.status).toBe("active");

    // Spend some of the slice, then dissolve: unspent must return to scope budget.
    await store.budgets.commit(team.budgetId!, 10, "measured");
    const dissolved = await dissolveTeam(store, active.id);
    expect(dissolved.status).toBe("dissolved");
    const slice = await store.budgets.get(team.budgetId!);
    expect(slice?.status).toBe("closed");
    const parent = await store.budgets.get(root.id);
    // Parent reserved drops by child limit (40), spent absorbs child spent (10).
    expect(parent?.reserved).toBe(0);
    expect(parent?.spent).toBe(10);
  });

  it("rejects invalid team transitions", () => {
    expect(TEAM_TRANSITIONS.forming).toContain("active");
    expect(TEAM_TRANSITIONS.active).toContain("dissolving");
    expect(TEAM_TRANSITIONS.dissolving).toContain("dissolved");
    expect(TEAM_TRANSITIONS.dissolved).toEqual([]);
  });

  it("enforces max team size", async () => {
    await store.agents.register("convener");
    const names: string[] = [];
    for (let i = 0; i < MAX_TEAM_SIZE; i++) {
      names.push(`member-${i}`);
      await store.agents.register(`member-${i}`);
    }
    await store.agents.register("extra");
    const team = await formTeam(store, {
      name: "full",
      scopeKind: "goal",
      scopeId: "goal:full",
      purpose: "x",
      convener: "convener",
    });
    for (const n of names) await joinTeam(store, team.id, n);
    await expect(joinTeam(store, team.id, "extra")).rejects.toThrow(
      /quota_exceeded/,
    );
  });
});

describe("discovery and negotiation", () => {
  it("nominates a bounded ranked set (targeted, never broadcast)", () => {
    const out = nominate(
      [
        { agent: "a", capabilityLevel: 0, affinity: 0, load: 0, warmed: false },
        { agent: "b", capabilityLevel: 2, affinity: 1, load: 0, warmed: true },
        { agent: "c", capabilityLevel: 1, affinity: 0, load: 0, warmed: false },
        { agent: "d", capabilityLevel: 1, affinity: 0, load: 0, warmed: false },
      ],
      2,
    );
    expect(out).toEqual(["b", "c"]); // ranked, K=2
  });

  it("walks the escalation ladder goal owner -> reviewer -> human", () => {
    expect(nextEscalation(0)).toBe(1);
    expect(nextEscalation(1)).toBe(2);
    expect(nextEscalation(2)).toBe(3);
    expect(nextEscalation(3)).toBeNull();
  });

  it("records dissent notes for verification", async () => {
    await store.agents.register("owner");
    const wi = await store.workItems.create("goal x", "queued");
    const t = await store.tasks.propose({
      workItemId: wi.id,
      title: "t",
      spec: {},
    });
    await store.agents.register("contributor");
    const id = await recordDissent(
      store,
      t.id,
      "contributor",
      "disagree: use async",
    );
    expect(id).toBeGreaterThan(0);
    const rows = await store.coordination.listDissents(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBe("disagree: use async");
  });
});

describe("runaway quotas and dedup", () => {
  it("rejects excess proposals on depth, fan-out, WIP and hourly rate", async () => {
    await store.agents.register("proposer");
    const limits = {
      maxDepth: 1,
      maxFanOut: 1,
      maxWip: 2,
      maxProposalsPerHour: 2,
    };
    const ok = await store.coordination.propose({
      goalId: 99,
      proposer: "proposer",
      depth: 0,
      title: "a",
      limits,
    });
    expect(ok.ok).toBe(true);
    const deep = await store.coordination.propose({
      goalId: 99,
      proposer: "proposer",
      depth: 5,
      title: "deep",
      limits,
    });
    expect(deep.ok).toBe(false);
    if (!deep.ok && "quotaExceeded" in deep)
      expect(deep.quotaExceeded).toBe("depth");

    // Pure checker agrees.
    expect(
      checkQuota({ depth: 5, fanOut: 0, wip: 0, proposalsLastHour: 0 }, limits),
    ).toBe("depth");
    expect(
      checkQuota({ depth: 0, fanOut: 9, wip: 0, proposalsLastHour: 0 }),
    ).toBe("fan-out");
    expect(
      checkQuota({ depth: 0, fanOut: 0, wip: 40, proposalsLastHour: 0 }),
    ).toBe("wip");
    expect(
      checkQuota({ depth: 0, fanOut: 0, wip: 0, proposalsLastHour: 25 }),
    ).toBe("proposals/hour");

    // WIP cap: goal 99 already has 1; allow one more then reject.
    const second = await store.coordination.propose({
      goalId: 99,
      proposer: "proposer",
      depth: 0,
      title: "b",
      limits,
    });
    expect(second.ok).toBe(true);
    const third = await store.coordination.propose({
      goalId: 99,
      proposer: "proposer",
      depth: 0,
      title: "c",
      limits,
    });
    expect(third.ok).toBe(false);
  });

  it("deduplicates on dedup_key", async () => {
    await store.agents.register("proposer");
    const a = await store.coordination.propose({
      goalId: 7,
      proposer: "proposer",
      depth: 0,
      dedupKey: "k1",
      title: "x",
    });
    expect(a.ok).toBe(true);
    const b = await store.coordination.propose({
      goalId: 7,
      proposer: "proposer",
      depth: 0,
      dedupKey: "k1",
      title: "x again",
    });
    expect(b.ok).toBe(false);
    if (!b.ok && "duplicate" in b) expect(b.duplicate).toBe(true);
  });
});

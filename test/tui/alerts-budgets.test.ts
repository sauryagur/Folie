import { describe, expect, it } from "vitest";
import {
  alertBadge,
  alertCount,
  alertLink,
  alertsLines,
  applyPoll,
  budgetLines,
  buildAlerts,
  buildBudgetTree,
  cycleView,
  enforcementLabel,
  enforcementWarning,
  initialState,
  paneLines,
  paneTitle,
  setView,
  VIEWS,
  type PollResult,
} from "../../src/tui/model";

const poll = (o: Partial<PollResult> = {}): PollResult => ({
  agents: [],
  messages: [],
  topics: [],
  ...o,
});

describe("alert ordering and linkage", () => {
  it("orders critical first, then newest, and keeps episode linkage", () => {
    const alerts = buildAlerts([
      {
        kind: "stall",
        at: "2026-11-04T12:05:00Z",
        agent: "agent-1",
        workItemId: 7,
      },
      {
        kind: "verification_rejected",
        at: "2026-11-04T12:00:00Z",
        episodeId: "ep-42",
      },
      {
        kind: "budget_exhausted",
        at: "2026-11-04T12:10:00Z",
        episodeId: "ep-9",
      },
      {
        kind: "undelivered_publication",
        at: "2026-11-04T12:20:00Z",
        agent: "agent-2",
      },
    ]);
    expect(alerts.map((a) => a.kind)).toEqual([
      "budget_exhausted",
      "verification_rejected",
      "stall",
      "undelivered_publication",
    ]);
    expect(alerts[0]!.episodeId).toBe("ep-9");
    expect(alertLink(alerts[0]!)).toContain("episode ep-9");
    expect(alertLink(alerts[2]!)).toContain("work item 7");
  });

  it("defaults severity and intervention per kind and carries icon output", () => {
    const alerts = buildAlerts([{ kind: "policy_denied" }, { kind: "stall" }]);
    expect(alerts[0]!.severity).toBe("warning");
    expect(alerts[0]!.intervention).toContain("policy");
    const lines = alertsLines(alerts);
    expect(lines[0]).toMatch(/^[!✗●]/);
    expect(lines[0]).toContain("warning");
    expect(lines[0]).toContain("→");
    expect(lines[0]).toContain("intervene:");
    expect(alertCount([{ kind: "stall" }])).toBe(1);
    expect(alertBadge([{ kind: "stall" }, { kind: "stall" }])).toBe("alerts 2");
  });

  it("shows a clear empty state", () => {
    expect(alertsLines([])).toEqual(["✓ no alerts — attention queue clear"]);
  });

  it("keeps all eight kinds addressable", () => {
    const kinds = [
      "verification_rejected",
      "budget_exhausted",
      "stall",
      "approval_expiring",
      "execution_lost",
      "policy_denied",
      "stale_fence_conflict",
      "undelivered_publication",
    ] as const;
    const alerts = buildAlerts(kinds.map((kind) => ({ kind })));
    expect(alerts.map((a) => a.kind).sort()).toEqual([...kinds].sort());
  });
});

describe("budget tree headroom math", () => {
  it("computes headroom as limit minus spent minus reserved", () => {
    const roots = buildBudgetTree([
      { id: 1, name: "goal", dim: "usd", limit: 100, reserved: 20, spent: 55 },
      {
        id: 2,
        name: "team-a",
        dim: "usd",
        limit: 40,
        reserved: 5,
        spent: 10,
        parentId: 1,
      },
      {
        id: 3,
        name: "task-1",
        dim: "tokens",
        limit: 1000,
        reserved: 100,
        spent: 1200,
        parentId: 2,
      },
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.headroom).toBe(25);
    expect(roots[0]!.children[0]!.headroom).toBe(25);
    expect(roots[0]!.children[0]!.children[0]!.headroom).toBe(-300);
  });

  it("forecasts exhaustion from burn rate", () => {
    const [root] = buildBudgetTree([
      {
        id: 1,
        name: "goal",
        dim: "usd",
        limit: 100,
        reserved: 10,
        spent: 40,
        spentPerMin: 5,
      },
    ]);
    expect(root!.exhaustInMins).toBe(10);
    const lines = budgetLines([root!]);
    expect(lines.some((l) => l.includes("exhausts in ~10m"))).toBe(true);
    const over = budgetLines(
      buildBudgetTree([
        { id: 1, name: "goal", dim: "usd", limit: 10, reserved: 5, spent: 20 },
      ]),
    );
    expect(over.some((l) => l.includes("over"))).toBe(true);
  });

  it("prints spent vs reserved vs headroom with the E-tier warning label", () => {
    const lines = budgetLines(
      buildBudgetTree([
        {
          id: 1,
          name: "root",
          dim: "tool-calls",
          limit: 100,
          reserved: 10,
          spent: 20,
        },
      ]),
    );
    expect(lines[0]).toContain("spent=20");
    expect(lines[0]).toContain("reserved=10");
    expect(lines[0]).toContain("headroom=70");
    expect(lines[1]).toContain("E0 record-only");
    expect(enforcementLabel()).toContain("E0 record-only");
    expect(enforcementLabel("E1")).toContain("E1 stops within one model turn");
    expect(enforcementLabel("E2")).toContain("E2 gateway-enforced");
    expect(enforcementWarning("E2")).toContain("gateway-enforced");
  });
});

describe("state wiring", () => {
  it("carries signals and budgets through applyPoll and renders them in the pane", () => {
    let s = applyPoll(
      initialState(),
      poll({
        alertSignals: [{ kind: "stall", episodeId: "ep-1" }],
        budgets: [
          { id: 1, name: "root", dim: "usd", limit: 10, reserved: 0, spent: 3 },
        ],
      }),
    );
    expect(s.alertSignals).toHaveLength(1);
    expect(s.budgets).toHaveLength(1);
    s = setView(s, "alerts");
    expect(paneTitle(s)).toContain("alerts (1)");
    expect(paneLines(s)[0]).toContain("stall");
    s = setView(s, "budgets");
    expect(paneTitle(s)).toBe("budgets");
    expect(paneLines(s)[0]).toContain("headroom=7");
  });

  it("keeps existing views in place and appends the new ones", () => {
    expect(VIEWS.slice(0, 5)).toEqual([
      "stream",
      "inbox",
      "topics",
      "reports",
      "inspector",
    ]);
    expect(VIEWS.slice(5)).toEqual(["alerts", "budgets"]);
    const cycled = cycleView(setView(initialState(), "inspector"));
    expect(cycled.view).toBe("alerts");
  });
});

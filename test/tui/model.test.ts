import { describe, expect, it } from "vitest";
import {
  STREAM_CAP,
  activity,
  ageLabel,
  applyPoll,
  cycleView,
  failureLines,
  failureSignals,
  fleetHeader,
  fleetRows,
  formatMessage,
  initialState,
  moveSelection,
  paneLines,
  pollFailed,
  withStatus,
  select,
  setView,
  type PollResult,
} from "../../src/tui/model";
import type { AgentInfo, Message, Report } from "../../src/shared/types";

const NOW = Date.parse("2026-11-04T12:00:00Z");

const agent = (name: string, o: Partial<AgentInfo> = {}): AgentInfo => ({
  name,
  state: "running",
  wakeEpoch: 1,
  unread: 0,
  lastActiveAt: "2026-11-04T11:59:30Z",
  ...o,
});

const msg = (id: number, o: Partial<Message> = {}): Message => ({
  id,
  from: "human",
  to: "agent-1",
  body: `body ${id}`,
  workItemId: null,
  topic: null,
  createdAt: "2026-11-04T12:03:05Z",
  ackedAt: null,
  ...o,
});

const poll = (o: Partial<PollResult> = {}): PollResult => ({
  agents: [],
  messages: [],
  topics: [],
  ...o,
});

describe("applyPoll", () => {
  it("takes agents and topics as given and marks the connection up", () => {
    const s = applyPoll(
      initialState(),
      poll({
        agents: [agent("a")],
        topics: [{ topic: "t", subscribers: ["a"] }],
      }),
    );
    expect(s).toMatchObject({
      agents: [{ name: "a" }],
      topics: [{ topic: "t" }],
      connected: true,
      status: "connected",
    });
  });

  it("selects the first agent, then keeps the selection across polls", () => {
    let s = applyPoll(
      initialState(),
      poll({ agents: [agent("a"), agent("b")] }),
    );
    expect(s.selected).toBe("a");
    s = select(s, "b");
    s = applyPoll(s, poll({ agents: [agent("a"), agent("b"), agent("c")] }));
    expect(s.selected).toBe("b");
  });

  it("falls back to the first agent when the selected one disappears, and to none when the fleet is empty", () => {
    let s = select(
      applyPoll(initialState(), poll({ agents: [agent("a"), agent("b")] })),
      "b",
    );
    s = applyPoll(s, poll({ agents: [agent("a")] }));
    expect(s.selected).toBe("a");
    expect(applyPoll(s, poll({ agents: [] })).selected).toBeNull();
  });

  it("appends new messages, advances the cursor, and ignores ones it already has", () => {
    let s = applyPoll(initialState(), poll({ messages: [msg(1), msg(2)] }));
    expect(s.cursor).toBe(2);
    s = applyPoll(s, poll({ messages: [msg(2), msg(3)] }));
    expect(s.stream.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(s.cursor).toBe(3);
  });

  it("never moves the cursor backwards", () => {
    const s = applyPoll(
      applyPoll(initialState(), poll({ messages: [msg(10)] })),
      poll({ messages: [] }),
    );
    expect(s.cursor).toBe(10);
  });

  it("keeps only the newest STREAM_CAP messages", () => {
    const many = Array.from({ length: STREAM_CAP + 25 }, (_, i) => msg(i + 1));
    const s = applyPoll(initialState(), poll({ messages: many }));
    expect(s.stream).toHaveLength(STREAM_CAP);
    expect(s.stream[0]!.id).toBe(26);
    expect(s.stream.at(-1)!.id).toBe(STREAM_CAP + 25);
  });

  it("drops inbox data fetched for an agent that is no longer selected (a poll in flight while the selection moved)", () => {
    const fleet = [agent("a"), agent("b")];
    let s = select(applyPoll(initialState(), poll({ agents: fleet })), "b");
    s = applyPoll(s, poll({ agents: fleet, inbox: [msg(1)], forAgent: "a" }));
    expect(s.inbox).toEqual([]);
    s = applyPoll(s, poll({ agents: fleet, inbox: [msg(2)], forAgent: "b" }));
    expect(s.inbox).toEqual([msg(2)]);
  });

  it("replaces inbox and reports only when the poll carried them", () => {
    const report: Report = {
      id: 1,
      agent: "a",
      outcome: "done",
      summary: "s",
      messageIds: [],
      createdAt: "2026-11-04T12:00:00Z",
    };
    let s = applyPoll(
      initialState(),
      poll({ inbox: [msg(1)], reports: [report] }),
    );
    s = applyPoll(s, poll());
    expect(s.inbox).toHaveLength(1);
    expect(s.reports).toHaveLength(1);
    expect(applyPoll(s, poll({ inbox: [] })).inbox).toEqual([]);
  });
});

describe("pollFailed", () => {
  it("keeps what is on screen and says the server is unreachable", () => {
    const up = applyPoll(
      initialState(),
      poll({ agents: [agent("a")], messages: [msg(1)] }),
    );
    const down = pollFailed(up, new Error("ECONNREFUSED"));
    expect(down).toMatchObject({
      connected: false,
      polled: true,
      error: expect.stringMatching(/folie up/),
    });
    expect(down.agents).toHaveLength(1);
    expect(down.stream).toHaveLength(1);
  });

  it("reconnecting restores the status line", () => {
    const down = pollFailed(initialState(), "boom");
    expect(applyPoll(down, poll()).status).toBe("connected");
  });

  it("persistent error survives transient status and clears on a good poll", () => {
    const down = pollFailed(initialState(), new Error("boom"));
    expect(down.error).toMatch(/server error/);
    const noted = withStatus(down, "message #5 sent");
    expect(noted.error).toBe(down.error);
    expect(noted.status).toBe("message #5 sent");
    const up = applyPoll(noted, poll());
    expect(up.error).toBeNull();
    expect(up.connected).toBe(true);
  });
});

describe("selection and views", () => {
  const fleet = [agent("a"), agent("b"), agent("c")];
  const three = () => applyPoll(initialState(), poll({ agents: fleet }));

  it("moves within bounds and does not wrap", () => {
    let s = three();
    s = moveSelection(s, -1);
    expect(s.selected).toBe("a");
    s = moveSelection(moveSelection(moveSelection(s, 1), 1), 1);
    expect(s.selected).toBe("c");
  });

  it("changing agent clears the per-agent panes so the old agent's mail is not shown for the new one", () => {
    let s = applyPoll(
      three(),
      poll({ agents: fleet, inbox: [msg(1)], reports: [] }),
    );
    expect(s.inbox).toHaveLength(1);
    s = moveSelection(s, 1);
    expect(s.inbox).toEqual([]);
    s = select(applyPoll(s, poll({ agents: fleet, inbox: [msg(2)] })), "c");
    expect(s.inbox).toEqual([]);
  });

  it("selecting the same agent again changes nothing", () => {
    const s = applyPoll(three(), poll({ agents: fleet, inbox: [msg(1)] }));
    expect(select(s, "a")).toBe(s);
  });

  it("does nothing with no agents", () => {
    const s = initialState();
    expect(moveSelection(s, 1)).toBe(s);
  });

  it("cycles views in order, both ways, wrapping", () => {
    let s = initialState();
    expect(s.view).toBe("stream");
    s = cycleView(s);
    expect(s.view).toBe("inbox");
    expect(cycleView(s, 6).view).toBe("stream");
    expect(cycleView(initialState(), -1).view).toBe("budgets");
  });
});

describe("formatting", () => {
  it.each([
    ["2026-11-04T11:59:55Z", "5s"],
    ["2026-11-04T11:57:00Z", "3m"],
    ["2026-11-04T09:59:00Z", "2h"],
    ["2026-11-01T12:00:00Z", "3d"],
    ["2026-11-04T12:00:30Z", "0s"], // clock skew: never negative
  ])("ageLabel(%s) = %s", (iso, label) => {
    expect(ageLabel(iso, NOW)).toBe(label);
  });

  it("describes what an agent is doing from state and mailbox", () => {
    expect(activity(agent("a", { unread: 2 }))).toBe("working");
    expect(activity(agent("a"))).toBe("idle");
    expect(activity(agent("a", { state: "pending", unread: 1 }))).toBe(
      "waking",
    );
    expect(activity(agent("a", { state: "pending" }))).toBe("new");
    expect(activity(agent("a", { state: "suspended" }))).toBe("suspended");
    expect(activity(agent("a", { state: "retired" }))).toBe("retired");
  });

  it("shows a crashed agent as failed rather than working, until it is retired", () => {
    expect(activity(agent("a", { unread: 1, failure: "no key" }))).toBe("failed");
    expect(
      activity(agent("a", { state: "retired", failure: "no key" })),
    ).toBe("retired");
  });

  it("opens the inspector with why the selected agent failed and how to retry", () => {
    const failed = agent("a", { unread: 1, failure: "process exited with code 1: no key" });
    const s = setView(
      select(applyPoll(initialState(), poll({ agents: [failed] })), "a"),
      "inspector",
    );
    expect(paneLines(s).slice(0, 2)).toEqual([
      "✗ failed: process exited with code 1: no key",
      "  retry: resume a   (restart Folie first if you changed its config)",
    ]);
    expect(failureLines(agent("a"))).toEqual([]);
    expect(failureLines(undefined)).toEqual([]);
  });

  it("raises failed agents as execution_lost alerts with a resume intervention", () => {
    expect(
      failureSignals([
        agent("a", { failure: "boom" }),
        agent("b"),
        agent("c", { state: "retired", failure: "old" }),
      ]),
    ).toEqual([
      {
        kind: "execution_lost",
        agent: "a",
        detail: "a failed: boom",
        intervention: "resume a",
      },
    ]);
  });

  it("lays the fleet out in aligned columns", () => {
    const rows = fleetRows(
      [agent("agent-1", { unread: 3 }), agent("a", { state: "suspended" })],
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["agent-1", "a"]);
    expect(rows[0]!.line).toBe("agent-1  working      3   30s");
    expect(rows[1]!.line).toBe("a        suspended    0   30s");
  });

  it("lines the header columns up with the rows, past the selection gutter", () => {
    const agents = [agent("agent-1", { unread: 3 })];
    const [row] = fleetRows(agents, NOW);
    const header = fleetHeader(agents).slice(3); // the list draws a 3-cell marker before each row
    for (const col of ["state", "mail", "quiet"]) {
      expect(header.indexOf(col) + col.length).toBeGreaterThan(0);
    }
    expect(header.indexOf("state")).toBe(row!.line.indexOf("working"));
    expect(header.indexOf("mail") + 4).toBe(row!.line.indexOf("3") + 1);
    expect(header.length).toBe(row!.line.length);
  });

  it("formats a message with sender, recipient, topic and work item in UTC", () => {
    expect(formatMessage(msg(14, { body: "do\n  it", workItemId: 7 }))).toBe(
      "12:03:05 #14 human > agent-1 (work item 7)  do it",
    );
    expect(
      formatMessage(msg(15, { from: "bob", to: "a", topic: "news" })),
    ).toBe("12:03:05 #15 bob > a [news]  body 15");
  });
});

describe("paneLines", () => {
  it("shows a hint instead of a blank pane when there is nothing yet", () => {
    for (const view of ["stream", "inbox", "reports", "topics"] as const) {
      const lines = paneLines({ ...initialState(), view });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toBe("");
    }
  });

  it("renders the active view's data", () => {
    const s = applyPoll(
      initialState(),
      poll({
        messages: [msg(1)],
        topics: [{ topic: "news", subscribers: ["a", "b"] }],
      }),
    );
    expect(paneLines(s)).toEqual([formatMessage(msg(1))]);
    expect(paneLines({ ...s, view: "topics" })).toEqual(["news  ←  a, b"]);
  });
});

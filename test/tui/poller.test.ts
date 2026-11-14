import { describe, expect, it } from "vitest";
import type { MessageQuery, Message, Report } from "../../src/shared/types";
import {
  applyPoll,
  initialState,
  setView,
  select,
  type TuiState,
} from "../../src/tui/model";
import { STREAM_PAGE, poll, type PollApi } from "../../src/tui/poller";

const message = (id: number): Message => ({
  id,
  from: "h",
  to: "a",
  body: "x",
  workItemId: null,
  topic: null,
  createdAt: "2026-11-04T12:00:00Z",
  ackedAt: null,
});
const report = (id: number): Report => ({
  id,
  agent: "a",
  outcome: "done",
  summary: `r${id}`,
  messageIds: [],
  createdAt: "2026-11-04T12:00:00Z",
});

function fakeApi() {
  const calls: string[] = [];
  const queries: MessageQuery[] = [];
  const api: PollApi = {
    agents: async () => (
      calls.push("agents"),
      [
        {
          name: "a",
          state: "running",
          wakeEpoch: 1,
          unread: 0,
          lastActiveAt: "2026-11-04T12:00:00Z",
        },
      ]
    ),
    messages: async (q = {}) => (
      calls.push("messages"),
      queries.push(q),
      [message(1), message(2)]
    ),
    topics: async () => (calls.push("topics"), []),
    inbox: async (a) => (calls.push(`inbox ${a}`), [message(7)]),
    reports: async (q = {}) => (
      calls.push(`reports ${q.agent} ${q.limit}`),
      [report(2), report(1)]
    ),
    stream: async () => [],
    listBudgets: async () => [],
  };
  return { api, calls, queries };
}

const withAgent = (s: TuiState) =>
  select(
    applyPoll(s, {
      agents: [
        {
          name: "a",
          state: "running",
          wakeEpoch: 1,
          unread: 0,
          lastActiveAt: "",
        },
      ],
      messages: [],
      topics: [],
    }),
    "a",
  );

describe("poll", () => {
  it("asks for the oldest page on first load, then only what follows the cursor", async () => {
    const { api, queries } = fakeApi();
    await poll(api, initialState());
    expect(queries[0]).toEqual({ after: 0, limit: STREAM_PAGE });

    const seen = applyPoll(initialState(), {
      agents: [],
      topics: [],
      messages: [message(41)],
    });
    await poll(api, seen);
    expect(queries[1]).toEqual({ after: 41, limit: STREAM_PAGE });
  });

  it("reads inbox and reports only for the view that shows them", async () => {
    const { api, calls } = fakeApi();
    await poll(api, withAgent(initialState()));
    expect(
      calls.filter((c) => c.startsWith("inbox") || c.startsWith("reports")),
    ).toEqual([]);

    calls.length = 0;
    const inbox = await poll(api, setView(withAgent(initialState()), "inbox"));
    expect(calls).toContain("inbox a");
    expect(inbox.inbox).toEqual([message(7)]);
    expect(inbox.reports).toBeUndefined();

    calls.length = 0;
    const reports = await poll(
      api,
      setView(withAgent(initialState()), "reports"),
    );
    expect(calls).toContain("reports a 50");
    expect(reports.inbox).toBeUndefined();
  });

  it("hands reports back oldest first, so the newest sits at the bottom like the rest of the panes", async () => {
    const { api } = fakeApi();
    const r = await poll(api, setView(withAgent(initialState()), "reports"));
    expect(r.reports!.map((x) => x.summary)).toEqual(["r1", "r2"]);
  });

  it("skips per-agent reads when no agent is selected", async () => {
    const { api, calls } = fakeApi();
    await poll(api, setView(initialState(), "inbox"));
    expect(calls.some((c) => c.startsWith("inbox"))).toBe(false);
  });

  it("propagates a failure so the caller can show the server as unreachable", async () => {
    const { api } = fakeApi();
    api.topics = async () => Promise.reject(new Error("ECONNREFUSED"));
    await expect(poll(api, initialState())).rejects.toThrow("ECONNREFUSED");
  });

  it("feeds alerts and budgets on the alerts/budgets views", async () => {
    const { api } = fakeApi();
    api.stream = async () => [
      {
        id: 1,
        type: "verification.verdict",
        aggregate: "verification",
        aggregateId: "7",
        actor: "agent:v",
        payload: { verdict: "fail", agent: "v" },
        correlationId: null,
        causationId: null,
        traceparent: null,
        tracestate: null,
        createdAt: "2026-11-04T12:00:00Z",
      },
    ];
    api.listBudgets = async () => [
      {
        id: 1,
        name: "root",
        dim: "usd",
        limitAmount: 10,
        reserved: 0,
        spent: 10,
        status: "exhausted",
        parentId: null,
      },
    ];
    const r = await poll(api, setView(withAgent(initialState()), "alerts"));
    expect(r.alertSignals).toHaveLength(2);
    expect(r.alertSignals![0]!.kind).toBe("verification_rejected");
    expect(r.alertSignals![1]!.kind).toBe("budget_exhausted");
    expect(r.budgets).toHaveLength(1);
  });

  it("lists a failed agent among the alerts", async () => {
    const { api } = fakeApi();
    api.agents = async () => [
      {
        name: "a",
        state: "running",
        wakeEpoch: 1,
        unread: 1,
        lastActiveAt: "2026-11-04T12:00:00Z",
        failure: "process exited with code 1: no key",
      },
    ];
    const r = await poll(api, setView(withAgent(initialState()), "alerts"));
    expect(r.alertSignals).toEqual([
      {
        kind: "execution_lost",
        agent: "a",
        detail: "a failed: process exited with code 1: no key",
        intervention: "resume a",
      },
    ]);
  });
});

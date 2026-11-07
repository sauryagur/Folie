import { describe, expect, it } from "vitest";
import {
  applyPoll,
  buildInspector,
  cancelPrompt,
  confirmCancelSession,
  copyTraceId,
  initialState,
  openTrace,
  requestCancelSession,
  select,
  type PollResult,
} from "../../src/tui/model";
import type { SessionEvent, SessionEventType } from "../../src/shared/types";

const ev = (
  id: number,
  type: SessionEventType,
  data: Record<string, unknown> = {},
  traceId: string | null = "trace-1",
): SessionEvent => ({
  id,
  agent: "agent-1",
  sessionId: "sess-9",
  scope: "wi:7",
  seq: id,
  type,
  data,
  traceId,
  createdAt: "2026-11-04T12:00:00Z",
});

const poll = (o: Partial<PollResult> = {}): PollResult => ({
  agents: [],
  messages: [],
  topics: [],
  ...o,
});

describe("inspector waterfall", () => {
  it("orders tool calls by start, pairing ends by call id", () => {
    const events = [
      ev(1, "turn_start"),
      ev(2, "tool_start", {
        callId: "c2",
        tool: "bash",
        replayable: false,
        risk: "high",
      }),
      ev(3, "tool_start", {
        callId: "c1",
        tool: "read",
        replayable: true,
        risk: "low",
      }),
      ev(4, "tool_end", {
        callId: "c1",
        tool: "read",
        replayable: true,
        isError: false,
        durationMs: 12,
      }),
      ev(5, "tool_end", {
        callId: "c2",
        tool: "bash",
        replayable: false,
        isError: true,
        durationMs: 340,
      }),
      ev(6, "turn_end"),
    ];
    const i = buildInspector("agent-1", events);
    expect(i.tools.map((t) => t.callId)).toEqual(["c2", "c1"]);
    expect(i.tools[0]).toMatchObject({
      tool: "bash",
      durationMs: 340,
      replayable: false,
      risk: "high",
      isError: true,
      status: { icon: "✗", label: "failed" },
    });
    expect(i.tools[1]).toMatchObject({
      tool: "read",
      durationMs: 12,
      replayable: true,
      risk: "low",
      status: { icon: "✓", label: "done" },
    });
    expect(i.turns).toHaveLength(1);
    expect(i.turns[0]!.status).toMatchObject({ icon: "✓", label: "done" });
  });

  it("marks a started call with no end as interrupted, with icon and words", () => {
    const i = buildInspector("agent-1", [
      ev(1, "tool_start", { callId: "c1", tool: "bash", replayable: false }),
    ]);
    expect(i.tools[0]).toMatchObject({
      durationMs: null,
      status: { icon: "?", label: "interrupted" },
    });
  });

  it("shows model attributes when present and unknown when absent", () => {
    const events = [
      ev(1, "turn_start"),
      ev(2, "message", {
        role: "assistant",
        content: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: { input: 10, output: 5, cost: { total: 0.02 } },
        },
      }),
      ev(3, "message", { role: "user", content: "hi" }),
      ev(4, "turn_end"),
    ];
    const i = buildInspector("agent-1", events);
    expect(i.turns[0]!.messages[0]!.model).toMatchObject({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-6",
      "gen_ai.usage.input_tokens": "10",
      "gen_ai.usage.output_tokens": "5",
      "folie.llm.cost_usd": "0.02",
    });
    expect(i.turns[0]!.messages[1]!.model).toEqual({});
    expect(i.totalCostUsd).toBeCloseTo(0.02);
    const lines = i.turns[0]!.messages.map(
      (m) => m.model["gen_ai.response.model"] ?? "unknown",
    );
    expect(lines).toEqual(["claude-sonnet-4-6", "unknown"]);
  });

  it("reads steering and artifacts", () => {
    const events = [
      ev(1, "steer", { messageIds: [3, 4] }),
      ev(2, "artifact", {
        path: "out.txt",
        bytes: 42,
        sha256: "abc123",
        description: "result",
      }),
    ];
    const i = buildInspector("agent-1", events);
    expect(i.steering[0]!.messageIds).toEqual([3, 4]);
    expect(i.artifacts[0]).toMatchObject({
      path: "out.txt",
      bytes: 42,
      sha256: "abc123",
    });
  });
});

describe("inspector trace id", () => {
  it("copies the first trace id the events carry", () => {
    const i = buildInspector("agent-1", [
      ev(1, "turn_start", {}, null),
      ev(2, "tool_start", {}, "trace-42"),
    ]);
    expect(copyTraceId(i)).toBe("trace-42");
    expect(openTrace(i)).toEqual({ kind: "open-trace", traceId: "trace-42" });
  });

  it("has no copy or trace target until an event carries one", () => {
    const i = buildInspector("agent-1", [ev(1, "turn_start", {}, null)]);
    expect(copyTraceId(i)).toBeNull();
    expect(openTrace(i)).toBeNull();
  });
});

describe("inspector cancel gating", () => {
  it("produces only an unconfirmed command-only intent until confirmed", () => {
    const i = buildInspector("agent-1", [ev(1, "session_start")]);
    const unconfirmed = requestCancelSession(i);
    expect(unconfirmed).toMatchObject({
      kind: "cancel-session",
      agent: "agent-1",
      sessionId: "sess-9",
      confirmed: false,
      via: "command-only",
    });
    expect(cancelPrompt(unconfirmed)).toContain("cancel session confirm");
    const confirmed = confirmCancelSession(unconfirmed);
    expect(confirmed.confirmed).toBe(true);
    expect(confirmCancelSession(confirmed)).toBe(confirmed);
  });

  it("cannot cancel with no session loaded", () => {
    const cmd = requestCancelSession(buildInspector("agent-1", []));
    expect(cmd.sessionId).toBeNull();
    expect(cancelPrompt(cmd)).toBe("cancel session: no session loaded");
  });
});

describe("inspector state", () => {
  it("merges events on poll and clears them when the agent changes", () => {
    const events = [ev(1, "turn_start")];
    let s = applyPoll(
      initialState(),
      poll({ sessionEvents: events, forAgent: null }),
    );
    expect(s.sessionEvents).toEqual(events);
    s = applyPoll(
      s,
      poll({
        agents: [
          {
            name: "agent-2",
            state: "running",
            wakeEpoch: 1,
            unread: 0,
            lastActiveAt: "",
          },
        ],
        messages: [],
        topics: [],
      }),
    );
    s = select(s, "agent-2");
    expect(s.sessionEvents).toEqual([]);
  });
});

import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentServer } from "../../src/agent/loop";
import type { Runtime } from "../../src/agent/runtime";
import { storableTrace } from "../../src/shared/trace";
import type {
  InboxQuery,
  Message,
  SessionEventBatch,
  SessionEventInput,
  SubmitReportRequest,
} from "../../src/shared/types";
import { captureSink, memoryTelemetry } from "../support/otel";

const msg = (
  id: number,
  workItemId: number | null = null,
  body = "do it",
): Message => ({
  id,
  from: "human",
  to: "a",
  body,
  workItemId,
  topic: null,
  createdAt: "",
  ackedAt: null,
  traceparent: null,
  tracestate: null,
});

/** The server's inbox scoping, as the agent depends on it: a work item's mail plus mail that belongs to none. */
const scoped = (mail: Message[], q: InboxQuery) =>
  q.workItem === undefined
    ? mail
    : mail.filter(
        (m) =>
          m.workItemId === null ||
          (q.workItem !== "none" && m.workItemId === q.workItem),
      );

class FakeServer implements AgentServer {
  reports: SubmitReportRequest[] = [];
  batches: SessionEventBatch[] = [];
  reportError: Error | null = null;
  constructor(public mail: Message[]) {}
  get events(): SessionEventInput[] {
    return this.batches.flatMap((b) => b.events);
  }
  inbox = async (_agent: string, q: InboxQuery = {}) => scoped(this.mail, q);
  sessionEvents = async (b: SessionEventBatch) => (
    this.batches.push(b),
    { stored: b.events.length }
  );
  report = async (r: SubmitReportRequest) => {
    if (this.reportError) throw this.reportError;
    this.reports.push(r);
    this.mail = this.mail.filter((m) => !r.messageIds.includes(m.id));
    return {
      id: 1,
      agent: r.agent,
      outcome: r.outcome,
      summary: r.summary,
      messageIds: r.messageIds,
      createdAt: "",
    };
  };
  control = async (_agent: string, _after?: number) => ({
    cursor: 0,
    actions: [],
  });
}

const done: Runtime = { run: async () => ({ outcome: "done", summary: "s" }) };
const quiet = captureSink();

describe("AgentLoop.tick", () => {
  it("does nothing while the inbox is empty: only mail wakes an agent", async () => {
    let ran = 0;
    const loop = new AgentLoop(
      "a",
      new FakeServer([]),
      { run: async () => (ran++, { outcome: "done", summary: "s" }) },
      { out: quiet },
    );
    expect(await loop.tick()).toBe(false);
    expect(ran).toBe(0);
  });

  it("runs one session over a work item's mail and reports every message id", async () => {
    const server = new FakeServer([msg(1, 7), msg(2, 7, "more")]);
    const seen: Message[][] = [];
    const runtime: Runtime = {
      run: async (m) => (
        seen.push(m),
        { outcome: "done", summary: "all done" }
      ),
    };

    expect(
      await new AgentLoop("a", server, runtime, { out: quiet }).tick(),
    ).toBe(true);

    expect(seen).toEqual([[msg(1, 7), msg(2, 7, "more")]]);
    expect(server.reports).toHaveLength(1);
    expect(server.reports[0]).toMatchObject({
      agent: "a",
      outcome: "done",
      summary: "all done",
      messageIds: [1, 2],
    });
    expect(Date.parse(server.reports[0]!.startedAt)).not.toBeNaN();
  });

  it("never sends an empty summary", async () => {
    const server = new FakeServer([msg(1)]);
    await new AgentLoop(
      "a",
      server,
      { run: async () => ({ outcome: "done", summary: "" }) },
      { out: quiet },
    ).tick();
    expect(server.reports[0]!.summary).not.toBe("");
  });
});

describe("bounded sessions", () => {
  it("gives each work item its own fresh session; mail for another work item waits", async () => {
    const server = new FakeServer([msg(1, 5), msg(2, 6), msg(3, null)]);
    const sessions: { id: string; scope: string; batch: number[] }[] = [];
    const runtime: Runtime = {
      run: async (m, s) => (
        sessions.push({ id: s.id, scope: s.scope, batch: m.map((x) => x.id) }),
        { outcome: "done", summary: "s" }
      ),
    };
    let n = 0;
    const loop = new AgentLoop("a", server, runtime, {
      out: quiet,
      newSessionId: () => `s${++n}`,
    });

    await loop.tick();
    expect(server.mail.map((m) => m.id)).toEqual([2]); // wi 5's mail and the work-item-less mail are done; wi 6 untouched
    await loop.tick();

    expect(sessions).toEqual([
      { id: "s1", scope: "wi:5", batch: [1, 3] },
      { id: "s2", scope: "wi:6", batch: [2] },
    ]);
  });

  it("scopes a session over work-item-less mail as mail:<first id>", async () => {
    const scopes: string[] = [];
    await new AgentLoop(
      "a",
      new FakeServer([msg(4), msg(5, 9)]),
      {
        run: async (_m, s) => (
          scopes.push(s.scope),
          { outcome: "done", summary: "s" }
        ),
      },
      { out: quiet },
    ).tick();
    expect(scopes).toEqual(["mail:4"]);
  });
});

describe("mid-session steering", () => {
  it("hands new mail for the scope to the runtime once, and the one report acks initial and injected ids", async () => {
    const server = new FakeServer([msg(1, 5)]);
    const taken: number[][] = [];
    const runtime: Runtime = {
      run: async (_m, session) => {
        server.mail.push(
          msg(2, 5, "correction"),
          msg(3, 6, "other goal"),
          msg(4, null, "general"),
        );
        taken.push((await session.takeNewMail()).map((m) => m.id));
        taken.push((await session.takeNewMail()).map((m) => m.id)); // already consumed: not handed out again
        server.mail.push(msg(5, 5, "late correction"));
        taken.push((await session.takeNewMail()).map((m) => m.id));
        return { outcome: "done", summary: "s" };
      },
    };

    await new AgentLoop("a", server, runtime, { out: quiet }).tick();

    expect(taken).toEqual([[2, 4], [], [5]]); // wi 6's mail is not this session's business
    expect(server.reports).toHaveLength(1);
    expect(server.reports[0]!.messageIds).toEqual([1, 2, 4, 5]);
    expect(server.mail.map((m) => m.id)).toEqual([3]); // left for its own session
  });

  it("scopes work-item-less sessions to work-item-less mail", async () => {
    const server = new FakeServer([msg(1)]);
    const taken: number[][] = [];
    await new AgentLoop(
      "a",
      server,
      {
        run: async (_m, session) => {
          server.mail.push(msg(2, 8), msg(3));
          taken.push((await session.takeNewMail()).map((m) => m.id));
          return { outcome: "done", summary: "s" };
        },
      },
      { out: quiet },
    ).tick();
    expect(taken).toEqual([[3]]);
  });
});

describe("fail-fast", () => {
  it("reports a thrown runtime error as failed, marks the span, and does not retry", async () => {
    const { telemetry, named } = memoryTelemetry();
    const server = new FakeServer([msg(1, 5)]);
    let runs = 0;
    const loop = new AgentLoop(
      "a",
      server,
      {
        run: async () => {
          runs++;
          throw new Error("proof has a contradiction");
        },
      },
      { tracer: telemetry.tracer, out: quiet },
    );

    await loop.tick();
    await loop.tick();

    expect(server.reports).toEqual([
      expect.objectContaining({
        outcome: "failed",
        summary: "proof has a contradiction",
        messageIds: [1],
      }),
    ]);
    expect(runs).toBe(1);
    const [span] = named("folie.agent.session");
    expect(span!.status).toMatchObject({
      code: 2,
      message: "proof has a contradiction",
    });
    expect(span!.events.map((e) => e.name)).toContain("exception");
    expect(span!.attributes).toMatchObject({
      outcome: "failed",
      work_item_id: 5,
    });
  });

  it("marks the span failed when the runtime reports failure without throwing", async () => {
    const { telemetry, named } = memoryTelemetry();
    await new AgentLoop(
      "a",
      new FakeServer([msg(1)]),
      { run: async () => ({ outcome: "failed", summary: "API blocked" }) },
      { tracer: telemetry.tracer, out: quiet },
    ).tick();
    expect(named("folie.agent.session")[0]!.status.code).toBe(2);
  });

  it("keeps a finished session's report and resends it without rerunning the work", async () => {
    const server = new FakeServer([msg(1)]);
    server.reportError = new Error("server down");
    let runs = 0;
    const loop = new AgentLoop(
      "a",
      server,
      { run: async () => (runs++, { outcome: "done", summary: "s" }) },
      { out: quiet },
    );

    await loop.tick();
    expect(server.mail).toHaveLength(1);

    server.reportError = null;
    expect(await loop.tick()).toBe(true);
    expect(server.mail).toEqual([]);
    expect(runs).toBe(1);
    expect(server.reports).toHaveLength(1);
  });
});

describe("transcript and logs", () => {
  it("ships an ordered, session-scoped transcript from start to end", async () => {
    const server = new FakeServer([msg(1, 5)]);
    await new AgentLoop("a", server, done, {
      out: quiet,
      newSessionId: () => "sess1",
    }).tick();

    expect(
      server.batches.every(
        (b) => b.agent === "a" && b.sessionId === "sess1" && b.scope === "wi:5",
      ),
    ).toBe(true);
    const types = server.events.map((e) => e.type);
    expect(types[0]).toBe("session_start");
    expect(types.at(-1)).toBe("session_end");
    expect(server.events.map((e) => e.seq)).toEqual(
      server.events.map((_, i) => i),
    );
  });

  it("writes structured lines carrying agent_name, work_item_id, trace_id and span_id, and mirrors them into the transcript", async () => {
    const { telemetry } = memoryTelemetry();
    const sink = captureSink();
    const server = new FakeServer([msg(1, 5)]);
    await new AgentLoop("a", server, done, {
      tracer: telemetry.tracer,
      out: sink,
    }).tick();

    const line = JSON.parse(sink.lines[0]!);
    expect(line).toMatchObject({
      agent_name: "a",
      work_item_id: 5,
      level: "info",
    });
    expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(
      server.events.filter((e) => e.type === "log").map((e) => e.data.line),
    ).toContain(sink.lines[0]);
  });
});

describe("trace context", () => {
  it("makes the session span a child of the span stored on the work item's first message", async () => {
    const { telemetry, named } = memoryTelemetry();
    const root = telemetry.tracer.startSpan("submit");
    const stored = storableTrace(trace.setSpan(context.active(), root));
    root.end();

    const server = new FakeServer([{ ...msg(1, 5), ...stored }]);
    await new AgentLoop("a", server, done, {
      tracer: telemetry.tracer,
      out: quiet,
    }).tick();

    const session = named("folie.agent.session")[0]!;
    expect(session.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(session.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });
});

describe("AgentLoop.run", () => {
  it("survives a failing tick and stops on abort", async () => {
    const server = new FakeServer([msg(1)]);
    let calls = 0;
    const inbox = server.inbox;
    server.inbox = async (agent, q) => {
      if (++calls === 1) throw new Error("transient");
      return inbox(agent, q);
    };
    const stop = new AbortController();
    const loop = new AgentLoop(
      "a",
      server,
      {
        run: async () => {
          queueMicrotask(() => stop.abort());
          return { outcome: "done", summary: "s" };
        },
      },
      { out: quiet },
    );

    await loop.run(1, stop.signal);
    expect(server.reports).toHaveLength(1);
  });
});

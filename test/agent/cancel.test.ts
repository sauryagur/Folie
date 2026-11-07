import { describe, expect, it, vi } from "vitest";
import { AgentLoop, type AgentServer } from "../../src/agent/loop";
import type { Runtime, SessionResult } from "../../src/agent/runtime";
import type {
  Message,
  SessionEventBatch,
  SessionUsage,
  SubmitReportRequest,
} from "../../src/shared/types";
import { captureSink } from "../support/otel";

const msg = (id: number, workItemId: number): Message => ({
  id,
  from: "human",
  to: "a",
  body: "do it",
  workItemId,
  topic: null,
  createdAt: "",
  ackedAt: null,
  traceparent: null,
  tracestate: null,
});

class FakeServer implements AgentServer {
  reports: SubmitReportRequest[] = [];
  constructor(public mail: Message[]) {}
  inbox = async () => this.mail;
  sessionEvents = async (_b: SessionEventBatch) => ({ stored: 0 });
  report = async (r: SubmitReportRequest) => {
    this.reports.push(r);
    return {
      id: 1,
      agent: r.agent,
      outcome: r.outcome,
      summary: r.summary,
      messageIds: r.messageIds,
      createdAt: "",
    };
  };
  control = async () => ({ cursor: 0, actions: [] });
}

const quiet = captureSink();
const usage: SessionUsage = {
  promptTokens: 12,
  completionTokens: 4,
  costUsd: 0.002,
  toolCalls: 1,
  toolFailures: 0,
};

/**
 * A runtime that stalls on a tool stub until the session's abort signal fires, then settles
 * failed with the cancel reason and the usage recorded before the cancel.
 */
function stallRuntime(probe: {
  started: boolean;
  toolSawAbort: boolean;
}): Runtime {
  return {
    run: (_messages, session) => {
      probe.started = true;
      const { promise, resolve } = Promise.withResolvers<SessionResult>();
      // A tool stub that completes only when the session's abort signal fires.
      session.signal!.addEventListener(
        "abort",
        () => {
          probe.toolSawAbort = true;
          resolve({
            outcome: "failed",
            summary: `cancelled: ${String(session.signal!.reason)}`,
            usage,
          });
        },
        { once: true },
      );
      return promise;
    },
  };
}

describe("session cancel", () => {
  it("a cancel aborts the running session; its report carries the reason and partial usage", async () => {
    const server = new FakeServer([msg(1, 7)]);
    const probe = { started: false, toolSawAbort: false };
    const loop = new AgentLoop("a", server, stallRuntime(probe), {
      out: quiet,
    });

    const tick = loop.tick();
    await vi.waitFor(() => expect(probe.started).toBe(true));
    expect(loop.cancelActive("operator stop")).toBe(true);
    expect(await tick).toBe(true);

    expect(probe.toolSawAbort).toBe(true); // the tool stub saw the abort
    const report = server.reports[0]!;
    expect(report.outcome).toBe("failed");
    expect(report.summary).toBe("cancelled: operator stop");
    expect(report.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 4,
      toolCalls: 1,
    });
    expect(loop.cancelActive("again")).toBe(false); // settled: nothing running anymore
  });

  it("cancel with no session running is a no-op", () => {
    const loop = new AgentLoop(
      "a",
      new FakeServer([]),
      stallRuntime({ started: false, toolSawAbort: false }),
      { out: quiet },
    );
    expect(loop.cancelActive("x")).toBe(false);
  });
});

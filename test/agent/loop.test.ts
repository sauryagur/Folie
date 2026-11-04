import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentServer } from "../../src/agent/loop";
import type { Runtime } from "../../src/agent/runtime";
import type { Message, SubmitReportRequest } from "../../src/shared/types";
import { silent } from "../support/fakes";

const msg = (id: number, body = "do it"): Message => ({
  id, from: "human", to: "a", body, workItemId: null, createdAt: "", ackedAt: null,
});

class FakeServer implements AgentServer {
  reports: SubmitReportRequest[] = [];
  reportError: Error | null = null;
  constructor(public mail: Message[]) {}
  inbox = async () => this.mail;
  report = async (r: SubmitReportRequest) => {
    if (this.reportError) throw this.reportError;
    this.reports.push(r);
    this.mail = this.mail.filter((m) => !r.messageIds.includes(m.id));
    return { id: 1, agent: r.agent, outcome: r.outcome, summary: r.summary, messageIds: r.messageIds, createdAt: "" };
  };
}

describe("AgentLoop.tick", () => {
  it("does nothing while the inbox is empty: only mail wakes an agent", async () => {
    let ran = 0;
    const loop = new AgentLoop("a", new FakeServer([]), { run: async () => (ran++, { outcome: "done", summary: "s" }) }, silent);
    expect(await loop.tick()).toBe(false);
    expect(ran).toBe(0);
  });

  it("runs one session over the whole inbox and reports every message id", async () => {
    const server = new FakeServer([msg(1), msg(2, "more")]);
    const seen: Message[][] = [];
    const runtime: Runtime = { run: async (m) => (seen.push(m), { outcome: "done", summary: "all done" }) };

    expect(await new AgentLoop("a", server, runtime, silent).tick()).toBe(true);

    expect(seen).toEqual([[msg(1), msg(2, "more")]]);
    expect(server.reports).toHaveLength(1);
    expect(server.reports[0]).toMatchObject({ agent: "a", outcome: "done", summary: "all done", messageIds: [1, 2] });
    expect(Date.parse(server.reports[0]!.startedAt)).not.toBeNaN();
  });

  it("turns a runtime exception into a failed report instead of crashing", async () => {
    const server = new FakeServer([msg(1)]);
    const loop = new AgentLoop("a", server, { run: async () => { throw new Error("model exploded"); } }, silent);
    await loop.tick();
    expect(server.reports[0]).toMatchObject({ outcome: "failed", summary: "model exploded", messageIds: [1] });
  });

  it("never sends an empty summary", async () => {
    const server = new FakeServer([msg(1)]);
    await new AgentLoop("a", server, { run: async () => ({ outcome: "done", summary: "" }) }, silent).tick();
    expect(server.reports[0]!.summary).not.toBe("");
  });

  it("leaves messages unread when the report cannot be delivered, so the session reruns", async () => {
    const server = new FakeServer([msg(1)]);
    server.reportError = new Error("server down");
    const loop = new AgentLoop("a", server, { run: async () => ({ outcome: "done", summary: "s" }) }, silent);

    await expect(loop.tick()).rejects.toThrow("server down");
    expect(server.mail).toHaveLength(1);

    server.reportError = null;
    expect(await loop.tick()).toBe(true);
    expect(server.mail).toEqual([]);
  });
});

describe("AgentLoop.run", () => {
  it("survives a failing tick and stops on abort", async () => {
    const server = new FakeServer([msg(1)]);
    let calls = 0;
    server.inbox = async () => {
      if (++calls === 1) throw new Error("transient");
      return server.mail;
    };
    const stop = new AbortController();
    const loop = new AgentLoop("a", server, {
      run: async () => {
        queueMicrotask(() => stop.abort());
        return { outcome: "done", summary: "s" };
      },
    }, silent);

    await loop.run(1, stop.signal);
    expect(server.reports).toHaveLength(1);
  });
});

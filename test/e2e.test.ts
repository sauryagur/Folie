// End to end over real HTTP and Postgres semantics (PGlite): trace propagation across every hop,
// mid-session steering through the real PiRuntime, and the metrics the server derives from what agents report.
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { echoRuntime } from "../src/agent/runtimes/echo";
import { PiRuntime } from "../src/agent/runtimes/pi";
import { startCluster } from "./support/cluster";
import type { FakeAx } from "./support/fakes";
import { memoryTelemetry } from "./support/otel";

const mem = memoryTelemetry("folie-e2e");
const tracer = mem.telemetry.tracer;
const cluster = await startCluster({ obs: mem.telemetry });
const { client, tick, runAgents } = cluster;
let ax: FakeAx;
beforeEach(async () => void ({ ax } = await cluster.reset()));
afterAll(() => cluster.close());

const idOf = (s: ReadableSpan) => s.spanContext().spanId;
/** Work item ids restart at 1 after each reset, so the newest matching span is the current test's. */
const latest = (name: string, workItemId: number) => mem.named(name).filter((s) => s.attributes.work_item_id === workItemId).at(-1)!;
const traceOf = (s: ReadableSpan) => s.spanContext().traceId;

/** Names from `span`'s parent up to the root, within the spans of its trace. */
function ancestry(span: ReadableSpan): string[] {
  const inTrace = mem.spans().filter((s) => traceOf(s) === traceOf(span));
  const names: string[] = [];
  for (let p = inTrace.find((s) => idOf(s) === span.parentSpanContext?.spanId); p; p = inTrace.find((s) => idOf(s) === p!.parentSpanContext?.spanId)) {
    names.push(p.name);
  }
  return names;
}

describe("trace propagation", () => {
  it("one trace links submission, dispatch, wake, sandbox init, the agent's session and the report's settlement", async () => {
    const cli = tracer.startSpan("cli.submit");
    const { workItem } = await context.with(trace.setSpan(context.active(), cli), () =>
      client.submitGoal({ goal: "prove the lemma", intent: "mathematics" }),
    );
    cli.end();

    await tick(); // dispatch -> controller wake -> sandbox init
    await runAgents(() => echoRuntime, { tracer }); // the agent's session, its report

    const spans = mem.spans().filter((s) => traceOf(s) === cli.spanContext().traceId);
    const one = (name: string) => spans.filter((s) => s.name === name);
    const [submit] = one("folie.work_item.submit");
    const [session] = one("folie.agent.session");
    const [settle] = one("folie.report.settle");

    expect(submit!.attributes).toMatchObject({ work_item_id: workItem.id, "folie.intent": "mathematics" });
    expect(session!.attributes).toMatchObject({ agent_name: "agent-1", work_item_id: workItem.id, outcome: "done" });
    expect(settle!.attributes).toMatchObject({ work_item_id: workItem.id, outcome: "done" });
    expect(ancestry(session!)).toEqual([
      "folie.sandbox.init",
      "folie.controller.wake",
      "folie.dispatch",
      "folie.work_item.submit",
      "folie.http.request",
      "cli.submit",
    ]);
    // The report crosses HTTP from inside the session span, so settlement is its descendant.
    expect(ancestry(settle!).slice(0, 3)).toEqual(["folie.http.request", "folie.agent.session", "folie.sandbox.init"]);
  });

  it("a delegated message continues the delegating agent's trace into the peer's session", async () => {
    const root = tracer.startSpan("delegation");
    await client.registerAgent("worker"); await client.registerAgent("boss");
    await context.with(trace.setSpan(context.active(), root), () => client.send({ from: "human", to: "worker", body: "take this" }));
    root.end();

    await tick();
    await runAgents(() => echoRuntime, { tracer });

    const session = mem.named("folie.agent.session").find((s) => s.attributes.agent_name === "worker")!;
    expect(traceOf(session)).toBe(root.spanContext().traceId);
    expect(ancestry(session)).toContain("folie.message.send");
  });

  it("a request without a traceparent starts its own trace rather than failing", async () => {
    const { workItem } = await client.submitGoal({ goal: "no parent" });
    const submit = latest("folie.work_item.submit", workItem.id);
    expect(ancestry(submit)).toEqual(["folie.http.request"]);
  });
});

describe("mid-session steering, end to end", () => {
  const faux = fauxProvider();
  let workdir: string;
  beforeEach(async () => void (workdir = await mkdtemp(join(tmpdir(), "folie-e2e-"))));
  afterAll(() => rm(workdir, { recursive: true, force: true }));

  const piFor = (name: string) => {
    const models = createModels();
    models.setProvider(faux.provider);
    return new PiRuntime({ agentName: name, model: faux.getModel(), streamFn: models.streamSimple.bind(models), codingTools: [], workdir, server: client });
  };
  const tool = (name: string, args: Record<string, string>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

  it("takes a correction sent while the model is thinking, leaves another goal's mail for its own session, and acks everything it consumed", async () => {
    await client.registerAgent("steered");
    const first = (await client.submitGoal({ goal: "survey the literature", to: "steered" })).workItem;
    await tick();

    let modelSawMidTurn = "";
    const turn1: FauxResponseFactory = async () => {
      // Arrives while the session is running: a correction for this work item (no work item of its own) and a different goal.
      await client.send({ from: "human", to: "steered", body: "focus on 2024 papers" });
      await client.submitGoal({ goal: "unrelated goal", to: "steered" });
      return tool("topic_subscribe", { topic: "papers" });
    };
    const turn2: FauxResponseFactory = (ctx) => {
      modelSawMidTurn = JSON.stringify(ctx.messages);
      return tool("report_submit", { outcome: "done", summary: "surveyed 2024" });
    };
    faux.setResponses([turn1, turn2]);

    await runAgents((n) => piFor(n));

    expect(modelSawMidTurn).toContain("focus on 2024 papers");
    expect(modelSawMidTurn).not.toContain("unrelated goal");

    const all = await client.messages({ agent: "steered" });
    const correction = all.find((m) => m.body === "focus on 2024 papers")!;
    const other = all.find((m) => m.body === "unrelated goal")!;
    expect(correction.ackedAt).not.toBeNull(); // acked by the one report, though it arrived mid-session
    expect(other.ackedAt).toBeNull(); // not this session's mail
    const view = await client.workItem(first.id);
    expect(view.workItem.state).toBe("done");
    expect(view.report!.messageIds).toEqual(expect.arrayContaining([correction.id]));
    expect(view.report!.messageIds).toHaveLength(2);

    // The transcript records the injection.
    const steer = (await client.readEvents({ scope: `wi:${first.id}`, type: "steer" }))[0]!;
    expect(steer.data).toEqual({ messageIds: [correction.id] });
  });

  it("then gives the other goal a fresh session that knows nothing of the first", async () => {
    await client.registerAgent("fresh");
    await client.submitGoal({ goal: "alpha goal", to: "fresh" });
    await client.submitGoal({ goal: "beta goal", to: "fresh" });
    await tick();

    let secondContext = "";
    faux.setResponses([
      tool("report_submit", { outcome: "done", summary: "alpha done" }),
      (ctx) => ((secondContext = JSON.stringify(ctx.messages)), tool("report_submit", { outcome: "done", summary: "beta done" })),
    ]);
    await runAgents((n) => piFor(n));
    await runAgents((n) => piFor(n));

    expect(secondContext).toContain("beta goal");
    expect(secondContext).not.toContain("alpha goal");
    expect((await client.reports({ agent: "fresh" })).map((r) => r.summary).sort()).toEqual(["alpha done", "beta done"]);
  });
});

describe("what the server derives from sessions", () => {
  it("counts outcomes, tokens, tool calls and inbox latency by agent", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const workdir = await mkdtemp(join(tmpdir(), "folie-e2e-"));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("topic_subscribe", { topic: "t" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("report_submit", { outcome: "done", summary: "ok" })], { stopReason: "toolUse" }),
    ]);
    await client.registerAgent("metered");
    await client.submitGoal({ goal: "measure me", to: "metered" });
    await tick();
    await runAgents((name) => new PiRuntime({ agentName: name, model: faux.getModel(), streamFn: models.streamSimple.bind(models), codingTools: [], workdir, server: client }));
    await rm(workdir, { recursive: true, force: true });

    const m = await mem.metrics();
    expect(m["folie.session.outcome{agent_name=metered,outcome=done}"]).toBe(1);
    expect(m["folie.llm.tokens{agent_name=metered,type=prompt}"]).toBeGreaterThan(0);
    expect(m["folie.llm.tokens{agent_name=metered,type=completion}"]).toBeGreaterThan(0);
    expect(m["folie.tool.calls{agent_name=metered,tool.name=topic_subscribe,tool.replayable=true}"]).toBe(1);
    expect(m["folie.inbox.latency{agent_name=metered}"]).toBe(1);
  });

  it("reports queue depth per agent at collection time", async () => {
    mem.telemetry.metrics.observeInboxDepth(async () => (await client.agents()).map((a) => ({ agent: a.name, depth: a.unread })));
    await client.registerAgent("backlogged");
    await client.send({ from: "human", to: "backlogged", body: "1" });
    await client.send({ from: "human", to: "backlogged", body: "2" });
    expect((await mem.metrics())["folie.inbox.depth{agent_name=backlogged}"]).toBe(2);
  });
});

describe("fail-fast", () => {
  it("records the error on the session and settlement spans, parks the work item blocked, and does not retry", async () => {
    const { workItem } = await client.submitGoal({ goal: "impossible" });
    await tick();
    let runs = 0;
    const failing = { run: async () => { runs++; throw new Error("the lemma is false"); } };

    await runAgents(() => failing, { tracer });
    await tick();
    await runAgents(() => failing, { tracer });

    expect(runs).toBe(1);
    expect((await client.workItem(workItem.id)).workItem.state).toBe("blocked");
    const session = latest("folie.agent.session", workItem.id);
    expect(session.status).toMatchObject({ code: 2, message: "the lemma is false" });
    const settle = latest("folie.report.settle", workItem.id);
    expect(settle.status.code).toBe(2);
    expect(settle.attributes).toMatchObject({ outcome: "failed", "folie.work_item.parked": true });
    expect((await mem.metrics())["folie.session.outcome{agent_name=agent-1,outcome=failed}"]).toBe(1);
    expect(ax.tasks.size).toBe(1);
  });
});

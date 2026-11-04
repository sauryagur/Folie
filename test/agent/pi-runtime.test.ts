import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type JsonObject,
} from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRuntime, type SwarmServer } from "../../src/agent/runtimes/pi";
import type { Message, SendMessageRequest, ToolAttempt } from "../../src/shared/types";
import { memoryTelemetry } from "../support/otel";
import { fakeSession } from "../support/session";

const mail = (id: number, body: string, extra: Partial<Message> = {}): Message => ({
  id, from: "human", to: "a", body, workItemId: 1, topic: null, createdAt: "", ackedAt: null, ...extra,
});
const inbox = [mail(7, "write hello.txt")];

let dir: string;
let faux: FauxProviderHandle;
let sent: SendMessageRequest[];
let topicCalls: string[];
let earlier: ToolAttempt[];
let seenContexts: { role: string; content: unknown }[][];
/** What the fake server saw at the moment message_send reached it, to prove the write-ahead ordering. */
let eventsBeforeSend: { type: string; tool: unknown }[];
let delivered: () => { type: string; data: Record<string, unknown> }[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "folie-pi-"));
  faux = fauxProvider();
  sent = [];
  topicCalls = [];
  earlier = [];
  seenContexts = [];
  eventsBeforeSend = [];
  delivered = () => [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function runtime(overrides: Partial<SwarmServer> = {}) {
  const models = createModels();
  models.setProvider(faux.provider);
  const inner = models.streamSimple.bind(models);
  const streamFn: StreamFn = (model, context, options) => {
    seenContexts.push(context.messages.map((m) => ({ role: m.role, content: "content" in m ? m.content : undefined })));
    return inner(model, context, options);
  };
  const server: SwarmServer = {
    send: async (r) => {
      eventsBeforeSend = delivered().map((e) => ({ type: e.type, tool: e.data.tool }));
      sent.push(r);
      return { id: 99, ...r, workItemId: null, topic: null, createdAt: "", ackedAt: null };
    },
    subscribe: async (topic, r) => (topicCalls.push(`subscribe ${r.agent} ${topic}`), { topic, agent: r.agent }),
    unsubscribe: async (topic, r) => (topicCalls.push(`unsubscribe ${r.agent} ${topic}`), { topic, agent: r.agent }),
    publish: async (topic, r) => (topicCalls.push(`publish ${r.from} ${topic}: ${r.body}`), { delivered: 3 }),
    attempts: async () => earlier,
    ...overrides,
  };
  return new PiRuntime({ agentName: "a", model: faux.getModel(), streamFn, codingTools: [], workdir: dir, server });
}

/** Runs a session and exposes what it shipped. */
function run(messages: Message[], opts: Parameters<typeof fakeSession>[0] = {}) {
  const s = fakeSession(opts);
  delivered = () => s.delivered;
  return { s, result: runtime().run(messages, s.session) };
}

const toolTurn = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const report = (outcome: "done" | "failed", summary: string) => toolTurn("report_submit", { outcome, summary });

describe("results", () => {
  it("returns what the model submits through report_submit and stops there", async () => {
    faux.setResponses([report("done", "wrote it")]);
    expect(await run(inbox).result).toMatchObject({ outcome: "done", summary: "wrote it" });
  });

  it("lets the model report failure", async () => {
    faux.setResponses([report("failed", "cannot")]);
    expect(await run(inbox).result).toMatchObject({ outcome: "failed", summary: "cannot" });
  });

  it("falls back to the model's final text when it never calls report_submit", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("all finished")])]);
    expect(await run(inbox).result).toMatchObject({ outcome: "done", summary: "all finished" });
  });

  it("reports a model error as failed", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "429 rate limited" })]);
    expect(await run(inbox).result).toMatchObject({ outcome: "failed", summary: "429 rate limited" });
  });

  it("returns usage: tool calls and failures counted, tokens and cost summed", async () => {
    faux.setResponses([toolTurn("topic_subscribe", { topic: "t" }), toolTurn("artifact_register", { path: "../escape", description: "x" }), report("done", "s")]);
    const { usage } = await run(inbox).result;
    expect(usage).toMatchObject({ toolCalls: 3, toolFailures: 1 });
    expect(usage!.promptTokens).toBeGreaterThan(0);
    expect(usage!.completionTokens).toBeGreaterThan(0);
  });
});

describe("swarm tools", () => {
  it("delegates to peers via message_send, attributed to this agent", async () => {
    faux.setResponses([toolTurn("message_send", { to: "bob", body: "please review" }), report("done", "delegated")]);
    await run(inbox).result;
    expect(sent).toMatchObject([{ from: "a", to: "bob", body: "please review" }]);
  });

  it("subscribes, publishes and unsubscribes as this agent", async () => {
    faux.setResponses([
      toolTurn("topic_subscribe", { topic: "releases" }),
      toolTurn("topic_publish", { topic: "releases", body: "v2 is out" }),
      toolTurn("topic_unsubscribe", { topic: "releases" }),
      report("done", "announced"),
    ]);
    expect(await run(inbox).result).toMatchObject({ outcome: "done", summary: "announced" });
    expect(topicCalls).toEqual(["subscribe a releases", "publish a releases: v2 is out", "unsubscribe a releases"]);
  });

  it("tells the model which topic a message arrived on and who sent it", async () => {
    faux.setResponses([report("done", "s")]);
    await run([mail(9, "release cut", { from: "bob", topic: "releases", workItemId: null })]).result;
    expect(JSON.stringify(seenContexts[0])).toContain("#9 from bob on topic releases");
  });
});

describe("bounded sessions", () => {
  it("starts every session with an empty conversation: nothing carries over from the last one", async () => {
    faux.setResponses([report("done", "first")]);
    await run(inbox).result;
    faux.setResponses([report("done", "second")]);
    await run([mail(8, "now do more")]).result;

    const second = JSON.stringify(seenContexts.at(-1));
    expect(second).toContain("now do more");
    expect(second).not.toContain("write hello.txt");
    expect(seenContexts.at(-1)!.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("registers a durable artifact with size and hash, relative to the workspace", async () => {
    await mkdir(join(dir, "out"));
    await writeFile(join(dir, "out", "proof.txt"), "QED");
    faux.setResponses([toolTurn("artifact_register", { path: "out/proof.txt", description: "the proof" }), report("done", "s")]);
    const { s, result } = run(inbox);
    await result;

    const artifact = (await s.all()).find((e) => e.type === "artifact");
    expect(artifact!.data).toEqual({
      path: "out/proof.txt",
      bytes: 3,
      sha256: createHash("sha256").update("QED").digest("hex"),
      description: "the proof",
    });
  });

  it("refuses artifacts outside the workspace and says so to the model", async () => {
    faux.setResponses([toolTurn("artifact_register", { path: "../../etc/passwd", description: "x" }), report("failed", "blocked")]);
    const { s, result } = run(inbox);
    await result;
    expect((await s.all()).find((e) => e.type === "artifact")).toBeUndefined();
    expect(JSON.stringify(seenContexts.at(-1))).toContain("outside");
  });
});

describe("mid-session steering", () => {
  it("injects mail that arrives after a turn into the next model call", async () => {
    faux.setResponses([toolTurn("topic_subscribe", { topic: "t" }), report("done", "adjusted")]);
    const { s, result } = run(inbox, { mail: [[mail(8, "actually use the second dataset")]] });
    await result;

    expect(JSON.stringify(seenContexts[0])).not.toContain("second dataset");
    expect(JSON.stringify(seenContexts[1])).toContain("New mail arrived while you were working");
    expect(JSON.stringify(seenContexts[1])).toContain("#8 from human");
    expect(JSON.stringify(seenContexts[1])).toContain("actually use the second dataset");
    expect((await s.all()).find((e) => e.type === "steer")!.data).toEqual({ messageIds: [8] });
  });

  it("does not let a report stand when new instructions arrive after it: the model gets another turn", async () => {
    faux.setResponses([report("done", "premature"), report("failed", "redirected")]);
    const { result } = run(inbox, { mail: [[mail(8, "stop, new direction")]] });

    expect(await result).toMatchObject({ outcome: "failed", summary: "redirected" });
    expect(JSON.stringify(seenContexts[1])).toContain("stop, new direction");
  });

  it("survives a failing inbox poll: the session carries on", async () => {
    faux.setResponses([toolTurn("topic_subscribe", { topic: "t" }), report("done", "fine")]);
    const s = fakeSession();
    s.session.takeNewMail = async () => {
      throw new Error("server unreachable");
    };
    expect(await runtime().run(inbox, s.session)).toMatchObject({ outcome: "done", summary: "fine" });
  });
});

describe("tool replay safety", () => {
  it("tags every native tool with a replay policy: reads and idempotent setters are replayable, side effects are not", async () => {
    await writeFile(join(dir, "f.txt"), "x");
    faux.setResponses([
      toolTurn("message_send", { to: "bob", body: "hi" }),
      toolTurn("topic_subscribe", { topic: "t" }),
      toolTurn("topic_unsubscribe", { topic: "t" }),
      toolTurn("topic_publish", { topic: "t", body: "b" }),
      toolTurn("artifact_register", { path: "f.txt", description: "d" }),
      report("done", "s"),
    ]);
    const { s, result } = run(inbox);
    await result;
    const tags = Object.fromEntries((await s.all()).filter((e) => e.type === "tool_start").map((e) => [e.data.tool, e.data.replayable]));
    expect(tags).toEqual({
      message_send: false,
      topic_subscribe: true,
      topic_unsubscribe: true,
      topic_publish: false,
      artifact_register: true,
      report_submit: true,
    });
  });

  it("journals each call with its replayable flag, and the side effect is on the server's log BEFORE it runs", async () => {
    faux.setResponses([toolTurn("topic_subscribe", { topic: "t" }), toolTurn("message_send", { to: "bob", body: "hi" }), report("done", "s")]);
    const { s, result } = run(inbox);
    await result;

    const tools = (await s.all()).filter((e) => e.type === "tool_start" || e.type === "tool_end").map((e) => [e.type, e.data.tool, e.data.replayable]);
    expect(tools).toEqual([
      ["tool_start", "topic_subscribe", true],
      ["tool_end", "topic_subscribe", true],
      ["tool_start", "message_send", false],
      ["tool_end", "message_send", false],
      ["tool_start", "report_submit", true],
      ["tool_end", "report_submit", true],
    ]);
    expect(eventsBeforeSend).toContainEqual({ type: "tool_start", tool: "message_send" });
  });

  it("gives the same side effect the same idempotency key in a restarted session, and a different one for different args", async () => {
    faux.setResponses([toolTurn("message_send", { to: "bob", body: "hi" }), toolTurn("message_send", { to: "bob", body: "other" }), report("done", "s")]);
    await run(inbox, { id: "first" }).result;
    faux.setResponses([toolTurn("message_send", { to: "bob", body: "hi" }), report("done", "s")]);
    await run(inbox, { id: "second" }).result;

    const [firstHi, other, secondHi] = sent.map((r) => r.requestId);
    expect(secondHi).toBe(firstHi);
    expect(other).not.toBe(firstHi);
  });

  it("gives two identical calls within one session two keys: repeating on purpose is allowed", async () => {
    faux.setResponses([toolTurn("message_send", { to: "bob", body: "ping" }), toolTurn("message_send", { to: "bob", body: "ping" }), report("done", "s")]);
    await run(inbox).result;
    expect(new Set(sent.map((r) => r.requestId)).size).toBe(2);
  });

  it("after a crash re-runs interrupted idempotent state setters, never side effects, and tells the model what happened", async () => {
    earlier = [
      { sessionId: "old", callId: "1", tool: "topic_subscribe", replayable: true, args: { topic: "news" }, state: "interrupted" },
      { sessionId: "old", callId: "2", tool: "message_send", replayable: false, args: { to: "bob", body: "sent already" }, state: "done" },
      { sessionId: "old", callId: "3", tool: "message_send", replayable: false, args: { to: "carol", body: "cut off" }, state: "interrupted" },
      { sessionId: "old", callId: "4", tool: "topic_subscribe", replayable: true, args: { topic: "finished" }, state: "done" },
    ];
    faux.setResponses([report("done", "s")]);
    await run(inbox).result;

    expect(topicCalls).toEqual(["subscribe a news"]); // only the interrupted setter; not the finished one
    expect(sent).toEqual([]); // no side effect repeated
    const prompt = JSON.stringify(seenContexts[0]);
    expect(prompt).toContain("sent already");
    expect(prompt).toContain("STARTED BUT NEVER FINISHED");
    expect(prompt).toContain("Re-ran interrupted idempotent calls");
  });

  it("starts normally when the earlier attempts cannot be read", async () => {
    faux.setResponses([report("done", "s")]);
    const failing = runtime({
      attempts: async () => {
        throw new Error("down");
      },
    });
    expect(await failing.run(inbox, fakeSession().session)).toMatchObject({ outcome: "done" });
  });
});

describe("tracing", () => {
  it("nests tool spans under their turn, tagged with tool.name, tool.replayable and tool.exit_code", async () => {
    const { telemetry, named } = memoryTelemetry();
    faux.setResponses([toolTurn("message_send", { to: "bob", body: "hi" }), report("done", "s")]);
    await run(inbox, { tracer: telemetry.tracer }).result;

    const turns = named("folie.turn");
    expect(turns).toHaveLength(2);
    const send = named("folie.tool.message_send")[0]!;
    expect(send.attributes).toMatchObject({ "tool.name": "message_send", "tool.replayable": false, "tool.exit_code": 0 });
    expect(send.parentSpanContext?.spanId).toBe(turns[0]!.spanContext().spanId);
    expect(named("folie.tool.report_submit")[0]!.parentSpanContext?.spanId).toBe(turns[1]!.spanContext().spanId);
    expect(turns[0]!.attributes["llm.usage.prompt_tokens"]).toBeGreaterThan(0);
  });

  it("records a failing tool on its span without failing the session", async () => {
    const { telemetry, named } = memoryTelemetry();
    faux.setResponses([toolTurn("artifact_register", { path: "../x", description: "d" }), report("failed", "gave up")]);
    await run(inbox, { tracer: telemetry.tracer }).result;

    const span = named("folie.tool.artifact_register")[0]!;
    expect(span.status.code).toBe(2);
    expect(span.attributes).toMatchObject({ "tool.exit_code": 1, "tool.replayable": true });
  });
});

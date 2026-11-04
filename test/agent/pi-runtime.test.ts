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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRuntime } from "../../src/agent/runtimes/pi";
import type { Message } from "../../src/shared/types";

const inbox: Message[] = [
  { id: 7, from: "human", to: "a", body: "write hello.txt", workItemId: 1, topic: null, createdAt: "", ackedAt: null },
];

let dir: string;
let faux: FauxProviderHandle;
let sent: { from: string; to: string; body: string }[];
let topicCalls: string[];
let seenContexts: { role: string; content: unknown }[][];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "folie-pi-"));
  faux = fauxProvider();
  sent = [];
  topicCalls = [];
  seenContexts = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function runtime() {
  const models = createModels();
  models.setProvider(faux.provider);
  const inner = models.streamSimple.bind(models);
  const streamFn: StreamFn = (model, context, options) => {
    seenContexts.push(context.messages.map((m) => ({ role: m.role, content: "content" in m ? m.content : undefined })));
    return inner(model, context, options);
  };
  return new PiRuntime({
    agentName: "a",
    model: faux.getModel(),
    streamFn,
    codingTools: [],
    stateFile: join(dir, ".folie", "conversation.json"),
    server: {
      send: async (r) => (sent.push(r), { id: 99, ...r, workItemId: null, topic: null, createdAt: "", ackedAt: null }),
      subscribe: async (topic, r) => (topicCalls.push(`subscribe ${r.agent} ${topic}`), { topic, agent: r.agent }),
      unsubscribe: async (topic, r) => (topicCalls.push(`unsubscribe ${r.agent} ${topic}`), { topic, agent: r.agent }),
      publish: async (topic, r) => (topicCalls.push(`publish ${r.from} ${topic}: ${r.body}`), { delivered: 3 }),
    },
  });
}

const toolTurn = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("PiRuntime", () => {
  it("returns what the model submits through report_submit and stops there", async () => {
    faux.setResponses([toolTurn("report_submit", { outcome: "done", summary: "wrote it" })]);
    expect(await runtime().run(inbox)).toEqual({ outcome: "done", summary: "wrote it" });
  });

  it("lets the model report failure", async () => {
    faux.setResponses([toolTurn("report_submit", { outcome: "failed", summary: "cannot" })]);
    expect(await runtime().run(inbox)).toEqual({ outcome: "failed", summary: "cannot" });
  });

  it("delegates to peers via message_send, attributed to this agent", async () => {
    faux.setResponses([
      toolTurn("message_send", { to: "bob", body: "please review" }),
      toolTurn("report_submit", { outcome: "done", summary: "delegated" }),
    ]);
    await runtime().run(inbox);
    expect(sent).toEqual([{ from: "a", to: "bob", body: "please review" }]);
  });

  it("subscribes, publishes and unsubscribes as this agent", async () => {
    faux.setResponses([
      toolTurn("topic_subscribe", { topic: "releases" }),
      toolTurn("topic_publish", { topic: "releases", body: "v2 is out" }),
      toolTurn("topic_unsubscribe", { topic: "releases" }),
      toolTurn("report_submit", { outcome: "done", summary: "announced" }),
    ]);
    expect(await runtime().run(inbox)).toEqual({ outcome: "done", summary: "announced" });
    expect(topicCalls).toEqual(["subscribe a releases", "publish a releases: v2 is out", "unsubscribe a releases"]);
  });

  it("tells the model which topic a message arrived on", async () => {
    faux.setResponses([toolTurn("report_submit", { outcome: "done", summary: "s" })]);
    await runtime().run([{ ...inbox[0]!, id: 9, from: "bob", body: "release cut", topic: "releases", workItemId: null }]);
    expect(JSON.stringify(seenContexts[0])).toContain("#9 from bob on topic releases");
  });

  it("falls back to the model's final text when it never calls report_submit", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("all finished")])]);
    expect(await runtime().run(inbox)).toEqual({ outcome: "done", summary: "all finished" });
  });

  it("reports a model error as failed", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "429 rate limited" })]);
    expect(await runtime().run(inbox)).toEqual({ outcome: "failed", summary: "429 rate limited" });
  });

  it("shows the model the unread messages, with ids and senders", async () => {
    faux.setResponses([toolTurn("report_submit", { outcome: "done", summary: "s" })]);
    await runtime().run(inbox);
    const prompt = JSON.stringify(seenContexts[0]);
    expect(prompt).toContain("#7 from human");
    expect(prompt).toContain("write hello.txt");
  });

  it("persists the conversation and resumes it in the next session (suspend/resume memory)", async () => {
    faux.setResponses([toolTurn("report_submit", { outcome: "done", summary: "first" })]);
    await runtime().run(inbox);
    const saved = JSON.parse(await readFile(join(dir, ".folie", "conversation.json"), "utf8")) as unknown[];
    expect(saved.length).toBeGreaterThan(1);

    faux.setResponses([toolTurn("report_submit", { outcome: "done", summary: "second" })]);
    await runtime().run([{ ...inbox[0]!, id: 8, body: "now do more" }]);

    const firstCall = seenContexts[0]!.length;
    const secondCall = seenContexts.at(-1)!;
    expect(secondCall.length).toBeGreaterThan(firstCall);
    expect(JSON.stringify(secondCall)).toContain("write hello.txt");
    expect(JSON.stringify(secondCall)).toContain("now do more");
  });
});

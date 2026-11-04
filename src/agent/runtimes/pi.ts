// pi runtime: a pi-agent-core Agent with pi's coding tools plus Folie's swarm tools.
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { FolieClient } from "../../shared/client";
import type { Message } from "../../shared/types";
import type { Runtime, SessionResult } from "../runtime";

/** The slice of folie-server the swarm tools call. */
export type SwarmServer = Pick<FolieClient, "send" | "subscribe" | "unsubscribe" | "publish">;

export interface PiRuntimeDeps {
  agentName: string;
  model: Model<Api>;
  streamFn: StreamFn;
  /** pi's read/bash/edit/write tools, already bound to the working directory. */
  codingTools: AgentTool[];
  /** Where the conversation survives ax suspend/resume (must live under /workspace). */
  stateFile: string;
  server: SwarmServer;
}

const SYSTEM_PROMPT = (name: string) =>
  `You are ${name}, an autonomous coding agent in a swarm. You receive goals and delegated work as messages. ` +
  "Do the work with your tools. To hand work to a peer, call message_send; that wakes them. " +
  "Topics are broadcast channels: topic_subscribe to receive what is published there (even while you are suspended), topic_publish to tell every subscriber. " +
  "When finished, or when you cannot proceed, call report_submit exactly once with the outcome and a summary of what happened.";

const formatInbox = (messages: Message[]) =>
  `You have ${messages.length} unread message(s):\n\n` +
  messages.map((m) => `[#${m.id} from ${m.from}${m.topic ? ` on topic ${m.topic}` : ""}]\n${m.body}`).join("\n\n");

async function loadConversation(file: string): Promise<AgentMessage[]> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as AgentMessage[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Keeps each tool's params typed where it is defined; Agent stores the erased AgentTool. */
const swarmTool = <T extends TSchema>(t: AgentTool<T>) => t as unknown as AgentTool;

export class PiRuntime implements Runtime {
  constructor(private readonly d: PiRuntimeDeps) {}

  async run(messages: Message[]): Promise<SessionResult> {
    let reported: SessionResult | null = null;

    const swarmTools = [
      swarmTool({
        name: "message_send",
        label: "Send message",
        description: "Send a message to another agent's inbox. This wakes that agent (creating it if needed).",
        parameters: Type.Object({ to: Type.String(), body: Type.String() }),
        execute: async (_id, p) => {
          const m = await this.d.server.send({ from: this.d.agentName, to: p.to, body: p.body });
          return { content: [{ type: "text", text: `sent message #${m.id} to ${p.to}` }], details: {} };
        },
      }),
      swarmTool({
        name: "topic_subscribe",
        label: "Subscribe to topic",
        description: "Subscribe to a topic. Messages published there arrive in your inbox from now on, and wake you.",
        parameters: Type.Object({ topic: Type.String() }),
        execute: async (_id, p) => {
          await this.d.server.subscribe(p.topic, { agent: this.d.agentName });
          return { content: [{ type: "text", text: `subscribed to ${p.topic}` }], details: {} };
        },
      }),
      swarmTool({
        name: "topic_unsubscribe",
        label: "Unsubscribe from topic",
        description: "Stop receiving messages published to a topic.",
        parameters: Type.Object({ topic: Type.String() }),
        execute: async (_id, p) => {
          await this.d.server.unsubscribe(p.topic, { agent: this.d.agentName });
          return { content: [{ type: "text", text: `unsubscribed from ${p.topic}` }], details: {} };
        },
      }),
      swarmTool({
        name: "topic_publish",
        label: "Publish to topic",
        description: "Publish a message to every current subscriber of a topic except yourself. Each wakes if idle.",
        parameters: Type.Object({ topic: Type.String(), body: Type.String() }),
        execute: async (_id, p) => {
          const { delivered } = await this.d.server.publish(p.topic, { from: this.d.agentName, body: p.body });
          return { content: [{ type: "text", text: `delivered to ${delivered} subscriber(s) of ${p.topic}` }], details: {} };
        },
      }),
      swarmTool({
        name: "report_submit",
        label: "Submit report",
        description: "Report this session's outcome. Call once, last.",
        parameters: Type.Object({ outcome: Type.Union([Type.Literal("done"), Type.Literal("failed")]), summary: Type.String() }),
        execute: async (_id, p) => {
          reported = { outcome: p.outcome, summary: p.summary };
          return { content: [{ type: "text", text: "report recorded" }], details: {}, terminate: true };
        },
      }),
    ];

    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT(this.d.agentName),
        model: this.d.model,
        tools: [...this.d.codingTools, ...swarmTools],
        messages: await loadConversation(this.d.stateFile),
      },
      streamFn: this.d.streamFn,
    });

    await agent.prompt(formatInbox(messages));
    await agent.waitForIdle();

    await mkdir(dirname(this.d.stateFile), { recursive: true });
    await writeFile(this.d.stateFile, JSON.stringify(agent.state.messages));

    if (reported) return reported;
    const last = agent.state.messages.at(-1);
    if (last?.role === "assistant" && last.stopReason === "error") {
      return { outcome: "failed", summary: last.errorMessage ?? "model error" };
    }
    // The model finished without calling report_submit: take its final text as the summary.
    const text =
      last?.role === "assistant"
        ? last.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")
        : "";
    return { outcome: "done", summary: text || "(model returned no text)" };
  }
}

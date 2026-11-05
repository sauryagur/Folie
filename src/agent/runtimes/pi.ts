// pi runtime: one fresh pi-agent-core Agent per session, with pi's general tools plus Folie's swarm tools.
//
// Bounded sessions: the conversation starts empty every time and is never persisted. What must outlive a
// session is written to files under the workdir (/workspace) and registered with artifact_register.
//
// Mid-session steering: after every turn, the runtime polls folie-server (non-blocking, scoped to this
// session's work item) and pushes new mail into the agent's steering queue, so pi delivers it before the next model call.
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { context, trace, type Span } from "@opentelemetry/api";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { FolieClient } from "../../shared/client";
import { failSpan } from "../../shared/trace";
import type { Message, ToolAttempt } from "../../shared/types";
import { instrument, type ToolStats } from "../instrument";
import { AUTO_REPLAY, RequestIds, attemptNotice } from "../replay";
import type { Runtime, Session, SessionResult } from "../runtime";

/** The slice of folie-server the swarm tools call. */
export type SwarmServer = Pick<
  FolieClient,
  "send" | "subscribe" | "unsubscribe" | "publish" | "attempts"
>;

export interface PiRuntimeDeps {
  agentName: string;
  model: Model<Api>;
  streamFn: StreamFn;
  /** pi's read/bash/edit/write tools, already bound to the working directory. */
  codingTools: AgentTool[];
  /** The durable workspace. Artifacts must live under it. */
  workdir: string;
  server: SwarmServer;
}

const SYSTEM_PROMPT = (name: string, workdir: string) =>
  `You are ${name}, an autonomous agent in a swarm that works on arbitrary goals: research, mathematics, data and model training, engineering. ` +
  "You receive goals and delegated work as messages. Do the work with your tools. " +
  `Every session starts with a clean context: you remember nothing earlier. Your memory is ${workdir}. ` +
  "Read what is there before you start. Write findings, datasets, proofs, scripts and checkpoints as files, " +
  "and call artifact_register for each one that matters so it can be found later. " +
  "If the goal is larger than one session, write down where you stopped and what comes next, " +
  "then message_send that to yourself: the next phase starts fresh from your files, not from this conversation. " +
  "To hand work to a peer, call message_send; that wakes them. " +
  "Topics are broadcast channels: topic_subscribe to receive what is published there (even while you are suspended), topic_publish to tell every subscriber. " +
  "New mail can arrive while you work; it appears as a message from the user, and it may correct or redirect you. " +
  "If you cannot proceed (an unrecoverable contradiction, a blocked API), do not retry in circles: report failed with the reason. " +
  "When finished, call report_submit exactly once with the outcome and a summary of what happened and where the artifacts are.";

const formatMail = (heading: string, messages: Message[]) =>
  `${heading}\n\n` +
  messages
    .map(
      (m) =>
        `[#${m.id} from ${m.from}${m.topic ? ` on topic ${m.topic}` : ""}]\n${m.body}`,
    )
    .join("\n\n");

/** Keeps each tool's params typed where it is defined; Agent stores the erased AgentTool. */
const swarmTool = <T extends TSchema>(t: AgentTool<T>) =>
  t as unknown as AgentTool;

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export class PiRuntime implements Runtime {
  constructor(private readonly d: PiRuntimeDeps) {}

  async run(messages: Message[], session: Session): Promise<SessionResult> {
    // A holder, not a `let`: the tool callbacks below assign it, which TypeScript's flow analysis cannot see.
    const report: {
      value: { outcome: "done" | "failed"; summary: string } | null;
    } = { value: null };
    const stats: ToolStats & {
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
    } = {
      toolCalls: 0,
      toolFailures: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    };
    const sessionCtx = context.active();
    let turnCtx = sessionCtx;
    let turnSpan: Span | undefined;
    let llmStartedAt = 0;
    const ids = new RequestIds(session.scope);
    const { agentName, server, workdir } = this.d;

    const swarmTools = [
      swarmTool({
        name: "message_send",
        label: "Send message",
        description:
          "Send a message to another agent's inbox (or your own, to start a fresh phase). This wakes that agent.",
        parameters: Type.Object({ to: Type.String(), body: Type.String() }),
        replay: "never",
        execute: async (_id, p) => {
          const m = await server.send({
            from: agentName,
            to: p.to,
            body: p.body,
            requestId: ids.next("message_send", p),
          });
          return text(`sent message #${m.id} to ${p.to}`);
        },
      }),
      swarmTool({
        name: "topic_subscribe",
        label: "Subscribe to topic",
        description:
          "Subscribe to a topic. Messages published there arrive in your inbox from now on, and wake you.",
        parameters: Type.Object({ topic: Type.String() }),
        replay: "safe",
        execute: async (_id, p) => {
          await server.subscribe(p.topic, { agent: agentName });
          return text(`subscribed to ${p.topic}`);
        },
      }),
      swarmTool({
        name: "topic_unsubscribe",
        label: "Unsubscribe from topic",
        description: "Stop receiving messages published to a topic.",
        parameters: Type.Object({ topic: Type.String() }),
        replay: "safe",
        execute: async (_id, p) => {
          await server.unsubscribe(p.topic, { agent: agentName });
          return text(`unsubscribed from ${p.topic}`);
        },
      }),
      swarmTool({
        name: "topic_publish",
        label: "Publish to topic",
        description:
          "Publish a message to every current subscriber of a topic except yourself. Each wakes if idle.",
        parameters: Type.Object({ topic: Type.String(), body: Type.String() }),
        replay: "never",
        execute: async (_id, p) => {
          const { delivered } = await server.publish(p.topic, {
            from: agentName,
            body: p.body,
            requestId: ids.next("topic_publish", p),
          });
          return text(`delivered to ${delivered} subscriber(s) of ${p.topic}`);
        },
      }),
      swarmTool({
        name: "artifact_register",
        label: "Register artifact",
        description:
          "Record a file you produced (dataset, proof, script, checkpoint, report) so it can be found after this session. " +
          "The path must be under your workspace. Registering the same file again is harmless.",
        parameters: Type.Object({
          path: Type.String(),
          description: Type.String(),
        }),
        replay: "safe",
        execute: async (_id, p) => {
          const file = resolve(workdir, p.path);
          if (
            relative(workdir, file).startsWith("..") ||
            !file.startsWith(workdir + sep)
          )
            throw new Error(`${p.path} is outside ${workdir}`);
          const info = await stat(file);
          if (!info.isFile()) throw new Error(`${p.path} is not a file`);
          const digest = await sha256(file);
          session.events.emit("artifact", {
            path: relative(workdir, file),
            bytes: info.size,
            sha256: digest,
            description: p.description,
          });
          return text(
            `registered ${relative(workdir, file)} (${info.size} bytes, sha256 ${digest.slice(0, 12)})`,
          );
        },
      }),
      swarmTool({
        name: "report_submit",
        label: "Submit report",
        description: "Report this session's outcome. Call once, last.",
        parameters: Type.Object({
          outcome: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
          summary: Type.String(),
        }),
        replay: "safe", // only records the outcome in this process; the server is told once, after the session
        execute: async (_id, p) => {
          report.value = { outcome: p.outcome, summary: p.summary };
          return { ...text("report recorded"), terminate: true };
        },
      }),
    ];
    const tools = [...this.d.codingTools, ...swarmTools].map((t) =>
      instrument(t, session, () => turnCtx, stats),
    );

    // A restarted session first restores state a crash interrupted (idempotent tools only), then learns what else the last attempt did.
    const earlier = await server
      .attempts(agentName, session.scope, session.id)
      .catch((e): ToolAttempt[] => {
        session.log.error(
          "could not read earlier attempts:",
          e instanceof Error ? e.message : e,
        );
        return [];
      });
    const restored: string[] = [];
    for (const a of earlier.filter(
      (x) =>
        x.state === "interrupted" && x.replayable && AUTO_REPLAY.has(x.tool),
    )) {
      const tool = tools.find((t) => t.name === a.tool);
      if (!tool) continue;
      await tool.execute(`replay-${a.callId}`, a.args as never);
      restored.push(`${a.tool} ${JSON.stringify(a.args)}`);
    }

    const steer = async () => {
      try {
        const mail = await session.takeNewMail();
        if (mail.length === 0) return;
        // A report already recorded this turn is void: new instructions arrived after it.
        report.value = null;
        session.events.emit("steer", { messageIds: mail.map((m) => m.id) });
        agent.steer({
          role: "user",
          content: formatMail("New mail arrived while you were working:", mail),
          timestamp: Date.now(),
        });
      } catch (e) {
        // Polling is best effort: a server hiccup must not kill a session that is making progress.
        session.log.error(
          "inbox poll failed:",
          e instanceof Error ? e.message : e,
        );
      }
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT(agentName, workdir),
        model: this.d.model,
        tools,
        messages: [],
      },
      streamFn: this.d.streamFn,
      steeringMode: "all",
      finishTurn: steer,
    });

    agent.subscribe(async (event) => {
      switch (event.type) {
        case "turn_start":
          turnSpan = session.tracer.startSpan("folie.turn", {}, sessionCtx);
          turnCtx = trace.setSpan(sessionCtx, turnSpan);
          session.events.emit("turn_start", {});
          break;
        case "message_start":
          if (event.message.role === "assistant")
            llmStartedAt = performance.now();
          break;
        case "message_end": {
          const m: AgentMessage = event.message;
          session.events.emit("message", { role: m.role, content: m });
          if (m.role !== "assistant") break;
          stats.promptTokens += m.usage.input;
          stats.completionTokens += m.usage.output;
          stats.costUsd += m.usage.cost.total;
          turnSpan?.setAttributes({
            "llm.usage.prompt_tokens": m.usage.input,
            "llm.usage.completion_tokens": m.usage.output,
            "llm.usage.cost_usd": m.usage.cost.total,
            "llm.latency_ms": Math.round(performance.now() - llmStartedAt),
          });
          if (m.stopReason === "error" && turnSpan)
            failSpan(turnSpan, new Error(m.errorMessage ?? "model error"));
          break;
        }
        case "turn_end":
          turnSpan?.end();
          turnSpan = undefined;
          turnCtx = sessionCtx;
          session.events.emit("turn_end", {});
          await session.events.flush();
          break;
      }
    });

    const notice = [
      attemptNotice(earlier),
      restored.length
        ? `Re-ran interrupted idempotent calls: ${restored.join("; ")}`
        : "",
    ].filter(Boolean);
    try {
      await agent.prompt(
        [
          ...notice,
          formatMail(
            `You have ${messages.length} unread message(s):`,
            messages,
          ),
        ].join("\n\n"),
      );
      await agent.waitForIdle();
    } finally {
      turnSpan?.end(); // an aborted run never reaches turn_end
    }

    const usage = {
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      costUsd: stats.costUsd,
      toolCalls: stats.toolCalls,
      toolFailures: stats.toolFailures,
    };
    if (report.value) return { ...report.value, usage };
    const last = agent.state.messages.at(-1);
    if (last?.role === "assistant" && last.stopReason === "error") {
      return {
        outcome: "failed",
        summary: last.errorMessage ?? "model error",
        usage,
      };
    }
    // The model finished without calling report_submit: take its final text as the summary.
    const summary =
      last?.role === "assistant"
        ? last.content
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("\n")
        : "";
    return {
      outcome: "done",
      summary: summary || "(model returned no text)",
      usage,
    };
  }
}

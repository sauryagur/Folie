// Wake-on-inbox loop. Unread mail is the only thing that starts a session, and one session serves one work item.
//
// Session boundaries: the oldest unread message picks the work item; the session starts from that work item's mail
// (plus mail that belongs to no work item). Mail for other work items waits for its own, fresh session.
// Mid-session mail for the same scope reaches the runtime through `Session.takeNewMail`, and the final report acks
// the initial batch and everything taken since.
import { randomUUID } from "node:crypto";
import { trace, type Tracer } from "@opentelemetry/api";
import type { FolieClient } from "../shared/client";
import { jsonLogger, type LogSink } from "../shared/logger";
import { TRACER_NAME, contextFrom, failSpan, withSpan } from "../shared/trace";
import type { Message, SubmitReportRequest } from "../shared/types";
import { EventSink } from "./events";
import type { Runtime, Session, SessionResult } from "./runtime";

export type AgentServer = Pick<
  FolieClient,
  "inbox" | "report" | "sessionEvents"
>;

export interface LoopDeps {
  tracer?: Tracer;
  /** Where structured log lines go besides the transcript. Defaults to the console. */
  out?: LogSink;
  newSessionId?: () => string;
  /** Called after each session settles, so its spans leave the sandbox before it can be suspended. */
  flush?: () => Promise<void>;
}

const consoleOut: LogSink = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

export class AgentLoop {
  private readonly tracer: Tracer;
  private readonly out: LogSink;
  private readonly newSessionId: () => string;
  private readonly flush: () => Promise<void>;
  /** A finished session's report the server has not accepted yet. Re-sent before any new work, never re-computed. */
  private undelivered: SubmitReportRequest | null = null;

  constructor(
    private readonly name: string,
    private readonly server: AgentServer,
    private readonly runtime: Runtime,
    deps: LoopDeps = {},
  ) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
    this.out = deps.out ?? consoleOut;
    this.newSessionId = deps.newSessionId ?? randomUUID;
    this.flush = deps.flush ?? (async () => {});
  }

  /** Runs one session if mail is waiting. Returns whether anything ran. */
  async tick(): Promise<boolean> {
    if (this.undelivered) {
      await this.server.report(this.undelivered);
      this.undelivered = null;
      return true;
    }
    const unread = await this.server.inbox(this.name);
    const first = unread[0];
    if (!first) return false;

    const workItemId = first.workItemId;
    const batch = unread.filter(
      (m) => m.workItemId === null || m.workItemId === workItemId,
    );
    const scope = workItemId === null ? `mail:${first.id}` : `wi:${workItemId}`;
    await this.runSession(batch, scope, workItemId);
    await this.flush().catch(() => {}); // telemetry is best effort
    return true;
  }

  private runSession(
    batch: Message[],
    scope: string,
    workItemId: number | null,
  ): Promise<void> {
    const sessionId = this.newSessionId();
    const consumed = new Set(batch.map((m) => m.id));
    const startedAt = new Date().toISOString();
    const events = new EventSink(
      (e) =>
        this.server.sessionEvents({
          agent: this.name,
          sessionId,
          scope,
          events: e,
        }),
      (e) =>
        this.out.err(
          JSON.stringify({
            level: "error",
            agent_name: this.name,
            msg: `transcript delivery failed: ${e instanceof Error ? e.message : e}`,
          }),
        ),
    );
    const log = jsonLogger(
      {
        agent_name: this.name,
        ...(workItemId === null ? {} : { work_item_id: workItemId }),
        session_id: sessionId,
      },
      {
        out: (line) => (
          this.out.out(line),
          events.emit("log", { level: "info", line })
        ),
        err: (line) => (
          this.out.err(line),
          events.emit("log", { level: "error", line })
        ),
      },
    );
    const session: Session = {
      id: sessionId,
      scope,
      workItemId,
      events,
      tracer: this.tracer,
      log,
      takeNewMail: async () => {
        const fresh = (
          await this.server.inbox(this.name, { workItem: workItemId ?? "none" })
        ).filter((m) => !consumed.has(m.id));
        for (const m of fresh) consumed.add(m.id);
        return fresh;
      },
    };

    const attributes = {
      agent_name: this.name,
      "session.id": sessionId,
      "session.scope": scope,
      ...(workItemId === null ? {} : { work_item_id: workItemId }),
    };
    // The stored trace on the first message is the work item's dispatch (or the controller's wake): this span is its child.
    return withSpan(
      this.tracer,
      "folie.agent.session",
      { parent: contextFrom(batch[0]), attributes },
      async (span) => {
        events.emit("session_start", { messageIds: [...consumed] });
        log.log(`session start: ${batch.length} message(s)`);
        let result: SessionResult;
        try {
          result = await this.runtime.run(batch, session);
        } catch (e) {
          // Fail fast: the error goes on the span, the work item parks in 'blocked', and nothing retries it.
          failSpan(span, e);
          result = {
            outcome: "failed",
            summary: e instanceof Error ? e.message : String(e),
          };
        }
        if (result.outcome === "failed")
          failSpan(span, new Error(result.summary));
        if (result.usage) {
          span.setAttributes({
            "llm.usage.prompt_tokens": result.usage.promptTokens,
            "llm.usage.completion_tokens": result.usage.completionTokens,
            "llm.usage.cost_usd": result.usage.costUsd,
          });
        }
        span.setAttribute("outcome", result.outcome);
        log.log(`session ${result.outcome}: ${result.summary.slice(0, 200)}`);
        events.emit("session_end", {
          outcome: result.outcome,
          summary: result.summary.slice(0, 2000),
        });
        await events.flush();

        const report: SubmitReportRequest = {
          agent: this.name,
          startedAt,
          outcome: result.outcome,
          summary: result.summary || "(no summary)",
          messageIds: [...consumed],
          usage: result.usage,
        };
        try {
          await this.server.report(report);
        } catch (e) {
          // The work is done; do not redo it. Keep the report and re-send it on the next tick.
          this.undelivered = report;
          log.error(
            `report delivery failed, will resend: ${e instanceof Error ? e.message : e}`,
          );
        }
      },
    );
  }

  async run(pollMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let ran = false;
      try {
        ran = await this.tick();
      } catch (e) {
        this.out.err(
          JSON.stringify({
            level: "error",
            agent_name: this.name,
            msg: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      if (!ran) await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

// Wake-on-inbox loop. Inbox-non-empty is the only thing that starts a session.
import type { FolieClient } from "../shared/client";
import type { Logger } from "../shared/logger";
import type { Runtime, SessionResult } from "./runtime";

export type AgentServer = Pick<FolieClient, "inbox" | "report">;

export class AgentLoop {
  constructor(
    private readonly name: string,
    private readonly server: AgentServer,
    private readonly runtime: Runtime,
    private readonly log: Logger = console,
  ) {}

  /** Runs one session if mail is waiting. Returns whether a session ran. */
  async tick(): Promise<boolean> {
    const messages = await this.server.inbox(this.name);
    if (messages.length === 0) return false;

    const startedAt = new Date().toISOString();
    let result: SessionResult;
    try {
      result = await this.runtime.run(messages);
    } catch (e) {
      // One-shot failure: report it; the work item parks in 'blocked'. No retry.
      result = { outcome: "failed", summary: e instanceof Error ? e.message : String(e) };
    }
    // Reporting acks the messages. If this throws they stay unread and the next tick reruns (at-least-once).
    await this.server.report({
      agent: this.name,
      startedAt,
      outcome: result.outcome,
      summary: result.summary || "(no summary)",
      messageIds: messages.map((m) => m.id),
    });
    return true;
  }

  async run(pollMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let ran = false;
      try {
        ran = await this.tick();
      } catch (e) {
        this.log.error(`agent ${this.name}: ${e instanceof Error ? e.message : e}`);
      }
      if (!ran) await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

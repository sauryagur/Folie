// The seam between the agent loop and whatever actually does the work (pi today, others later).
import type { Tracer } from "@opentelemetry/api";
import type { StructuredLogger } from "../shared/logger";
import type { Message, Outcome, SessionUsage } from "../shared/types";
import type { EventSink } from "./events";

export interface SessionResult {
  outcome: Outcome;
  summary: string;
  usage?: SessionUsage;
}

/**
 * One bounded session: a single work item's goal (or one batch of mail that belongs to no work item).
 * A session starts with a fresh conversation and ends with one report; anything that must outlive it
 * lives in files under /workspace.
 */
export interface Session {
  id: string;
  /** `wi:<id>` or `mail:<id>`: what the transcript and replay log are keyed on. */
  scope: string;
  workItemId: number | null;
  /**
   * Mail that arrived for this session's scope since it began. Each message is returned once and is acked by the
   * session's final report together with the initial batch. Never blocks: an empty inbox returns [].
   */
  takeNewMail(): Promise<Message[]>;
  events: EventSink;
  tracer: Tracer;
  log: StructuredLogger;
}

export interface Runtime {
  /** One session over the initial `messages`. May throw: the loop reports that as a failed session. */
  run(messages: Message[], session: Session): Promise<SessionResult>;
}

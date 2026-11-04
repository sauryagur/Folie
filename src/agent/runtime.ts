// The seam between the agent loop and whatever actually does the work (pi today, others later).
import type { Message, Outcome } from "../shared/types";

export interface SessionResult {
  outcome: Outcome;
  summary: string;
}

export interface Runtime {
  /** One session over the unread messages. May throw: the loop reports that as a failed session. */
  run(messages: Message[]): Promise<SessionResult>;
}

// One refresh of everything the TUI shows. The active view decides which extra reads are worth making.
import type { FolieClient } from "../shared/client";
import type { PollResult, TuiState } from "./model";

export type PollApi = Pick<FolieClient, "agents" | "messages" | "topics" | "inbox" | "reports">;

/** How many messages the stream asks for on its first load and on each catch-up. */
export const STREAM_PAGE = 200;

export async function poll(api: PollApi, s: TuiState): Promise<PollResult> {
  // No cursor yet: ask for the newest page. After that, only what is new.
  const messages = s.cursor === 0 ? api.messages({ limit: STREAM_PAGE }) : api.messages({ after: s.cursor, limit: STREAM_PAGE });
  const [agents, msgs, topics, inbox, reports] = await Promise.all([
    api.agents(),
    messages,
    api.topics(),
    s.view === "inbox" && s.selected ? api.inbox(s.selected) : undefined,
    s.view === "reports" && s.selected ? api.reports({ agent: s.selected, limit: 50 }) : undefined,
  ]);
  return { agents, messages: msgs, topics, inbox, reports: reports?.slice().reverse(), forAgent: s.selected };
}

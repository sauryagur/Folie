// TUI state and its pure transitions. No terminal, no network: everything here is testable under Node.
import type { AgentInfo, Message, Report, TopicInfo } from "../shared/types";

export type View = "stream" | "inbox" | "topics" | "reports";
export const VIEWS: readonly View[] = ["stream", "inbox", "topics", "reports"];

/** The stream keeps this many newest messages; older ones scroll out of memory, not out of the database. */
export const STREAM_CAP = 500;

export interface TuiState {
  agents: AgentInfo[];
  /** Selected agent name; stays put across polls unless that agent disappears. */
  selected: string | null;
  view: View;
  stream: Message[];
  /** Highest message id seen, the cursor for the next poll. 0 until the first message. */
  cursor: number;
  /** Unread mail of the selected agent (view "inbox"). */
  inbox: Message[];
  /** Recent reports of the selected agent (view "reports"). */
  reports: Report[];
  topics: TopicInfo[];
  /** Result of the last command, or the last poll failure. */
  status: string;
  connected: boolean;
}

export const initialState = (): TuiState => ({
  agents: [],
  selected: null,
  view: "stream",
  stream: [],
  cursor: 0,
  inbox: [],
  reports: [],
  topics: [],
  status: "connecting…",
  connected: false,
});

/** What one poll brings back. Fields the active view did not need are absent. */
export interface PollResult {
  agents: AgentInfo[];
  messages: Message[];
  topics: TopicInfo[];
  inbox?: Message[];
  reports?: Report[];
  /** The agent `inbox` and `reports` were read for. A poll in flight while the selection moved must not fill the new agent's panes. */
  forAgent?: string | null;
}

export function applyPoll(s: TuiState, p: PollResult): TuiState {
  const current = p.forAgent === undefined || p.forAgent === s.selected;
  const known = new Set(s.stream.map((m) => m.id));
  const fresh = p.messages.filter((m) => !known.has(m.id));
  const stream = [...s.stream, ...fresh].slice(-STREAM_CAP);
  const selected = s.selected !== null && p.agents.some((a) => a.name === s.selected) ? s.selected : (p.agents[0]?.name ?? null);
  return {
    ...s,
    agents: p.agents,
    topics: p.topics,
    stream,
    cursor: stream.reduce((max, m) => Math.max(max, m.id), s.cursor),
    selected,
    inbox: current ? (p.inbox ?? s.inbox) : s.inbox,
    reports: current ? (p.reports ?? s.reports) : s.reports,
    connected: true,
    status: s.connected ? s.status : "connected",
  };
}

export const pollFailed = (s: TuiState, error: unknown): TuiState => ({
  ...s,
  connected: false,
  status: `server unreachable: ${error instanceof Error ? error.message : String(error)}`,
});

export const withStatus = (s: TuiState, status: string): TuiState => ({ ...s, status });

export function moveSelection(s: TuiState, delta: number): TuiState {
  if (s.agents.length === 0) return s;
  const at = Math.max(0, s.agents.findIndex((a) => a.name === s.selected));
  const next = Math.min(Math.max(at + delta, 0), s.agents.length - 1);
  return { ...s, selected: s.agents[next]!.name, inbox: [], reports: [] };
}

export function select(s: TuiState, name: string): TuiState {
  return s.selected === name ? s : { ...s, selected: name, inbox: [], reports: [] };
}

export function cycleView(s: TuiState, step = 1): TuiState {
  const at = VIEWS.indexOf(s.view);
  return setView(s, VIEWS[(at + step + VIEWS.length) % VIEWS.length]!);
}

export const setView = (s: TuiState, view: View): TuiState => ({ ...s, view });

// --- formatting ---

/** Seconds -> "5s", "3m", "2h", "4d". */
export function ageLabel(iso: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** What the agent is doing right now, from its recorded state and mailbox. */
export function activity(a: AgentInfo): string {
  if (a.state === "running") return a.unread > 0 ? "working" : "idle";
  if (a.state === "pending") return a.unread > 0 ? "waking" : "new";
  return a.state; // suspended, retired
}

export interface FleetRow {
  name: string;
  /** One fixed-width line for the grid. */
  line: string;
}

const nameWidth = (agents: AgentInfo[]) => Math.min(Math.max(...agents.map((a) => a.name.length), 5), 24);

const columns = (name: string, state: string, mail: string, quiet: string, width: number) =>
  `${name.padEnd(width)}  ${state.padEnd(9)} ${mail.padStart(4)} ${quiet.padStart(5)}`;

export function fleetRows(agents: AgentInfo[], now: number): FleetRow[] {
  const width = nameWidth(agents);
  return agents.map((a) => ({
    name: a.name,
    line: columns(a.name, activity(a), String(a.unread), ageLabel(a.lastActiveAt, now), width),
  }));
}

/** Header for the grid; the leading gutter matches the list's selection marker. */
export const fleetHeader = (agents: AgentInfo[]) => `   ${columns("agent", "state", "mail", "quiet", nameWidth(agents))}`;

const utcTime = (iso: string) => new Date(iso).toISOString().slice(11, 19);

/** "12:03:05 #14 human > agent-1  goal text", or "... on topic news" for a publish. */
export function formatMessage(m: Message): string {
  const topic = m.topic ? ` [${m.topic}]` : "";
  const item = m.workItemId === null ? "" : ` (work item ${m.workItemId})`;
  const body = m.body.replace(/\s+/g, " ");
  return `${utcTime(m.createdAt)} #${m.id} ${m.from} > ${m.to}${topic}${item}  ${body}`;
}

export function formatReport(r: Report): string {
  return `${utcTime(r.createdAt)} #${r.id} ${r.outcome.toUpperCase()}  ${r.summary.replace(/\s+/g, " ")}`;
}

export function formatTopic(t: TopicInfo): string {
  return `${t.topic}  ←  ${t.subscribers.join(", ")}`;
}

/** The body of the right-hand pane for the active view. */
export function paneLines(s: TuiState): string[] {
  const who = s.selected ?? "(no agent)";
  switch (s.view) {
    case "stream":
      return s.stream.length ? s.stream.map(formatMessage) : ["No messages yet. Submit a goal with: submit <goal>"];
    case "inbox":
      return s.inbox.length ? s.inbox.map(formatMessage) : [`${who}: inbox empty`];
    case "reports":
      return s.reports.length ? s.reports.map(formatReport) : [`${who}: no reports yet`];
    case "topics":
      return s.topics.length ? s.topics.map(formatTopic) : ["No topics yet. Try: subscribe <topic> [agent]"];
  }
}

export const paneTitle = (s: TuiState) =>
  ({ stream: "message stream", inbox: `inbox: ${s.selected ?? "-"}`, reports: `reports: ${s.selected ?? "-"}`, topics: "topics" })[s.view];

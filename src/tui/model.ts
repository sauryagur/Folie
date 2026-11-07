// TUI state and its pure transitions. No terminal, no network: everything here is testable under Node.
import type {
  AgentInfo,
  Message,
  Report,
  SessionEvent,
  TopicInfo,
} from "../shared/types";

export type View =
  | "stream"
  | "inbox"
  | "topics"
  | "reports"
  | "inspector"
  | "alerts"
  | "budgets";
export const VIEWS: readonly View[] = [
  "stream",
  "inbox",
  "topics",
  "reports",
  "inspector",
  "alerts",
  "budgets",
];

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
  /** Neutral session events of the selected agent (view "inspector"). */
  sessionEvents: SessionEvent[];
  topics: TopicInfo[];
  /** Attention signals feeding the alerts queue (view "alerts"); empty until a feed supplies them. */
  alertSignals: AlertSignal[];
  /** Budget carve-outs feeding the budgets tree (view "budgets"); empty until a feed supplies them. */
  budgets: BudgetNodeInput[];
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
  sessionEvents: [],
  topics: [],
  alertSignals: [],
  budgets: [],
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
  sessionEvents?: SessionEvent[];
  alertSignals?: AlertSignal[];
  budgets?: BudgetNodeInput[];
  forAgent?: string | null;
}

// --- alerts (attention queue) ---
// Pure view-model over plain signals. No OTel is read here: signals arrive as data (via
// PollResult.alertSignals), so a dropped trace span never creates or hides an alert.

export type AlertKind =
  | "verification_rejected"
  | "budget_exhausted"
  | "stall"
  | "approval_expiring"
  | "execution_lost"
  | "policy_denied"
  | "stale_fence_conflict"
  | "undelivered_publication";
export type AlertSeverity = "critical" | "warning" | "info";

/** A raw attention signal, as a feed would supply it. Linkage fields are optional. */
export interface AlertSignal {
  kind: AlertKind;
  severity?: AlertSeverity;
  at?: string | null;
  agent?: string | null;
  workItemId?: number | null;
  episodeId?: string | null;
  detail?: string;
  intervention?: string;
}

export interface AlertItem {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  icon: string;
  label: string;
  at: string | null;
  agent: string | null;
  workItemId: number | null;
  episodeId: string | null;
  detail: string;
  intervention: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};
const SEVERITY_ICON: Record<AlertSeverity, string> = {
  critical: "✗",
  warning: "!",
  info: "●",
};

const DEFAULT_SEVERITY: Record<AlertKind, AlertSeverity> = {
  verification_rejected: "critical",
  budget_exhausted: "critical",
  execution_lost: "critical",
  policy_denied: "warning",
  stale_fence_conflict: "warning",
  approval_expiring: "warning",
  stall: "warning",
  undelivered_publication: "info",
};

const DEFAULT_INTERVENTION: Record<AlertKind, string> = {
  verification_rejected: "re-request verification",
  budget_exhausted: "raise budget or pause work",
  stall: "nudge or wake the agent",
  approval_expiring: "approve or deny before expiry",
  execution_lost: "resume the session",
  policy_denied: "adjust policy or appeal the denial",
  stale_fence_conflict: "rebase onto the current fence",
  undelivered_publication: "retry the publication",
};

/** Orders signals: critical first, then newest first, then kind. Pure and stable. */
export function buildAlerts(signals: AlertSignal[]): AlertItem[] {
  return signals
    .map((sig, i): AlertItem => {
      const severity = sig.severity ?? DEFAULT_SEVERITY[sig.kind];
      return {
        id: `${sig.kind}:${i}`,
        kind: sig.kind,
        severity,
        icon: SEVERITY_ICON[severity],
        label: sig.kind.replace(/_/g, " "),
        at: sig.at ?? null,
        agent: sig.agent ?? null,
        workItemId: sig.workItemId ?? null,
        episodeId: sig.episodeId ?? null,
        detail: sig.detail ?? "",
        intervention: sig.intervention ?? DEFAULT_INTERVENTION[sig.kind],
      };
    })
    .sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sev !== 0) return sev;
      const at = (b.at ?? "").localeCompare(a.at ?? "");
      if (at !== 0) return at;
      return a.kind.localeCompare(b.kind);
    });
}

/** Where an alert points: episode, work item, or agent — always stated as words. */
export const alertLink = (a: AlertItem): string =>
  a.episodeId
    ? `episode ${a.episodeId}`
    : a.workItemId !== null
      ? `work item ${a.workItemId}`
      : a.agent
        ? `agent ${a.agent}`
        : "fleet";

export const alertCount = (signals: AlertSignal[]): number => signals.length;

/** The header counter; the app renders it and `a` jumps to the alerts view. */
export const alertBadge = (signals: AlertSignal[]): string =>
  `alerts ${signals.length}`;

/** Every line carries icon + severity words, so status never rests on colour alone. */
export function alertsLines(alerts: AlertItem[]): string[] {
  if (!alerts.length) return ["✓ no alerts — attention queue clear"];
  return alerts.map(
    (a) =>
      `${a.icon} ${a.severity} ${a.label}  → ${alertLink(a)}  · intervene: ${a.intervention}${a.detail ? `  (${a.detail})` : ""}`,
  );
}

// --- budgets (carve-out tree) ---
// Pure view-model over plain budget records. Spent/reserved/headroom are computed here;
// enforcement honesty lives in the E-tier label, never in a colour.

export type BudgetDimension = "usd" | "tokens" | "tool-calls";
export type EnforcementTier = "E0" | "E1" | "E2";

export const ENFORCEMENT_LABELS: Record<EnforcementTier, string> = {
  E0: "E0 record-only",
  E1: "E1 stops within one model turn",
  E2: "E2 gateway-enforced",
};

export const enforcementLabel = (tier: EnforcementTier = "E0"): string =>
  ENFORCEMENT_LABELS[tier];

/** Stated like a warning label until the gateway lands; defaults to E0. */
export const enforcementWarning = (tier: EnforcementTier = "E0"): string =>
  `⚠ enforcement: ${enforcementLabel(tier)} — not gateway-enforced yet`;

/** One budget row as a feed supplies it; parentId links the carve-out tree. */
export interface BudgetNodeInput {
  id: number;
  name: string;
  dim: BudgetDimension | string;
  limit: number;
  reserved: number;
  spent: number;
  parentId?: number | null;
  tier?: EnforcementTier;
  /** Burn rate per minute in the same units as spent; enables the forecast. */
  spentPerMin?: number | null;
  status?: string;
}

export interface BudgetTreeNode {
  id: number;
  name: string;
  dim: string;
  limit: number;
  reserved: number;
  spent: number;
  /** limit − spent − reserved; negative means over budget. */
  headroom: number;
  tier: EnforcementTier;
  status: string;
  /** Minutes until exhaustion at the current burn rate; null when unknown or not burning. */
  exhaustInMins: number | null;
  children: BudgetTreeNode[];
}

export function buildBudgetTree(records: BudgetNodeInput[]): BudgetTreeNode[] {
  const byId = new Map<number, BudgetTreeNode>();
  const nodes = records.map((r): BudgetTreeNode => {
    const headroom = r.limit - r.spent - r.reserved;
    const burn = r.spentPerMin ?? null;
    return {
      id: r.id,
      name: r.name,
      dim: r.dim,
      limit: r.limit,
      reserved: r.reserved,
      spent: r.spent,
      headroom,
      tier: r.tier ?? "E0",
      status: r.status ?? "open",
      exhaustInMins:
        headroom <= 0 ? 0 : burn && burn > 0 ? headroom / burn : null,
      children: [],
    };
  });
  for (const n of nodes) byId.set(n.id, n);
  const roots: BudgetTreeNode[] = [];
  for (let i = 0; i < records.length; i++) {
    const node = nodes[i]!;
    const parent = records[i]!.parentId ?? null;
    const host = parent !== null ? byId.get(parent) : undefined;
    if (host && host !== node) host.children.push(node);
    else roots.push(node);
  }
  return roots;
}

const budgetStatus = (n: BudgetTreeNode): string =>
  n.headroom < 0
    ? "over"
    : n.headroom === 0
      ? "exhausted"
      : n.headroom / n.limit <= 0.2
        ? "tight"
        : "ok";

/** Tree lines with icon + words per node; the E-tier is always printed, like a warning label. */
export function budgetLines(roots: BudgetTreeNode[]): string[] {
  if (!roots.length) return ["? no budgets yet — submit a goal to create one"];
  const lines: string[] = [];
  const walk = (n: BudgetTreeNode, depth: number) => {
    const indent = "  ".repeat(depth);
    const status = budgetStatus(n);
    const icon =
      status === "over" || status === "exhausted"
        ? "✗"
        : status === "tight"
          ? "!"
          : "✓";
    const burn =
      n.exhaustInMins !== null
        ? `  burn → exhausts in ~${Math.round(n.exhaustInMins)}m`
        : "";
    lines.push(
      `${indent}${icon} ${n.name} [${n.dim}]  spent=${n.spent} reserved=${n.reserved} headroom=${n.headroom} ${status}  · ${n.status}${burn}`,
    );
    lines.push(`${indent}  ${enforcementWarning(n.tier)}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines;
}

export function applyPoll(s: TuiState, p: PollResult): TuiState {
  const selected =
    s.selected !== null && p.agents.some((a) => a.name === s.selected)
      ? s.selected
      : (p.agents[0]?.name ?? null);
  const switched = selected !== s.selected;
  const current = switched
    ? p.forAgent === selected
    : p.forAgent === undefined || p.forAgent === s.selected;
  const known = new Set(s.stream.map((m) => m.id));
  const fresh = p.messages.filter((m) => !known.has(m.id));
  const stream = [...s.stream, ...fresh].slice(-STREAM_CAP);
  const prev = <T>(v: T): T => (switched ? ([] as T) : v);
  return {
    ...s,
    agents: p.agents,
    topics: p.topics,
    stream,
    cursor: stream.reduce((max, m) => Math.max(max, m.id), s.cursor),
    selected,
    inbox: current ? (p.inbox ?? prev(s.inbox)) : prev(s.inbox),
    reports: current ? (p.reports ?? prev(s.reports)) : prev(s.reports),
    sessionEvents: current
      ? (p.sessionEvents ?? prev(s.sessionEvents))
      : prev(s.sessionEvents),
    alertSignals: p.alertSignals ?? s.alertSignals,
    budgets: p.budgets ?? s.budgets,
    connected: true,
    status: s.connected ? s.status : "connected",
  };
}

export const pollFailed = (s: TuiState, error: unknown): TuiState => ({
  ...s,
  connected: false,
  status: `server unreachable: ${error instanceof Error ? error.message : String(error)}`,
});

export const withStatus = (s: TuiState, status: string): TuiState => ({
  ...s,
  status,
});

export function moveSelection(s: TuiState, delta: number): TuiState {
  if (s.agents.length === 0) return s;
  const at = Math.max(
    0,
    s.agents.findIndex((a) => a.name === s.selected),
  );
  const next = Math.min(Math.max(at + delta, 0), s.agents.length - 1);
  return {
    ...s,
    selected: s.agents[next]!.name,
    inbox: [],
    reports: [],
    sessionEvents: [],
  };
}

export function select(s: TuiState, name: string): TuiState {
  return s.selected === name
    ? s
    : { ...s, selected: name, inbox: [], reports: [], sessionEvents: [] };
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

const nameWidth = (agents: AgentInfo[]) =>
  Math.min(Math.max(...agents.map((a) => a.name.length), 5), 24);

const columns = (
  name: string,
  state: string,
  mail: string,
  quiet: string,
  width: number,
) =>
  `${name.padEnd(width)}  ${state.padEnd(9)} ${mail.padStart(4)} ${quiet.padStart(5)}`;

export function fleetRows(agents: AgentInfo[], now: number): FleetRow[] {
  const width = nameWidth(agents);
  return agents.map((a) => ({
    name: a.name,
    line: columns(
      a.name,
      activity(a),
      String(a.unread),
      ageLabel(a.lastActiveAt, now),
      width,
    ),
  }));
}

/** Header for the grid; the leading gutter matches the list's selection marker. */
export const fleetHeader = (agents: AgentInfo[]) =>
  `   ${columns("agent", "state", "mail", "quiet", nameWidth(agents))}`;

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

// --- inspector (session theatre) ---
// Pure view-model over neutral SessionEvents. No OTel is read here: trace ids, durations and model
// attributes all come from the event rows themselves, so a dropped span never changes what is shown.

export interface InspectorStatus {
  icon: string;
  label: string;
}
export interface InspectorMessage {
  role: string;
  summary: string;
  /** `gen_ai.*` / `folie.llm.*` attributes carried by this message, when present. */
  model: Record<string, string>;
}
export interface InspectorTurn {
  index: number;
  startedAt: string | null;
  endedAt: string | null;
  status: InspectorStatus;
  messages: InspectorMessage[];
}
export interface InspectorToolCall {
  callId: string;
  tool: string;
  startId: number;
  endId: number | null;
  startedAt: string | null;
  durationMs: number | null;
  replayable: boolean | null;
  risk: string | null;
  costUsd: number | null;
  isError: boolean;
  status: InspectorStatus;
}
export interface InspectorSteer {
  id: number;
  at: string | null;
  messageIds: number[];
}
export interface InspectorArtifact {
  id: number;
  at: string | null;
  path: string;
  bytes: number | null;
  sha256: string | null;
  description: string | null;
}
export interface InspectorLog {
  id: number;
  at: string | null;
  level: string;
  line: string;
}
export interface InspectorModel {
  agent: string | null;
  sessionId: string | null;
  scope: string | null;
  eventCount: number;
  traceId: string | null;
  status: InspectorStatus;
  turns: InspectorTurn[];
  tools: InspectorToolCall[];
  steering: InspectorSteer[];
  artifacts: InspectorArtifact[];
  logs: InspectorLog[];
  totalCostUsd: number | null;
}
/** Cancel is never a button: the model only ever produces an unconfirmed, command-only intent. */
export interface CancelSessionCommand {
  kind: "cancel-session";
  agent: string | null;
  sessionId: string | null;
  confirmed: boolean;
  via: "command-only";
}
export interface OpenTrace {
  kind: "open-trace";
  traceId: string;
}

const ok = (label: string): InspectorStatus => ({ icon: "✓", label });
const bad = (label: string): InspectorStatus => ({ icon: "✗", label });
const live = (label: string): InspectorStatus => ({ icon: "●", label });
const unknown = (label: string): InspectorStatus => ({ icon: "?", label });

const dstr = (d: Record<string, unknown>, k: string) =>
  typeof d[k] === "string" ? (d[k] as string) : null;
const dnum = (d: Record<string, unknown>, k: string) =>
  typeof d[k] === "number" && Number.isFinite(d[k] as number)
    ? (d[k] as number)
    : null;
const dbool = (d: Record<string, unknown>, k: string) =>
  typeof d[k] === "boolean" ? (d[k] as boolean) : null;

function messageText(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.replace(/\s+/g, " ").trim();
    if (Array.isArray(o.content)) {
      const text = o.content
        .filter(
          (c): c is { text: string } =>
            !!c &&
            typeof c === "object" &&
            typeof (c as { text?: unknown }).text === "string",
        )
        .map((c) => c.text)
        .join(" ");
      return text.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

/** Attributes a message event carries, from its own data plus its nested assistant message. */
function modelAttributes(
  data: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (
      (k.startsWith("gen_ai.") || k.startsWith("folie.llm.")) &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    ) {
      out[k] = String(v);
    }
  }
  const content = data.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as Record<string, unknown>;
    const provider = dstr(c, "provider");
    if (provider) out["gen_ai.provider.name"] = provider;
    const model = dstr(c, "model");
    if (model) {
      out["gen_ai.request.model"] = model;
      out["gen_ai.response.model"] = model;
    }
    const usage = c.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const u = usage as Record<string, unknown>;
      const input = dnum(u, "input");
      const output = dnum(u, "output");
      if (input !== null) out["gen_ai.usage.input_tokens"] = String(input);
      if (output !== null) out["gen_ai.usage.output_tokens"] = String(output);
      const cost = u.cost;
      if (cost && typeof cost === "object" && !Array.isArray(cost)) {
        const total = dnum(cost as Record<string, unknown>, "total");
        if (total !== null) out["folie.llm.cost_usd"] = String(total);
      } else {
        const total = dnum(u, "costUsd") ?? dnum(u, "cost_usd");
        if (total !== null) out["folie.llm.cost_usd"] = String(total);
      }
    }
  }
  return out;
}

export function buildInspector(
  agent: string | null,
  events: SessionEvent[],
): InspectorModel {
  const sorted = [...events].sort((a, b) => a.id - b.id || a.seq - b.seq);
  const traceId = sorted.find((e) => e.traceId !== null)?.traceId ?? null;
  const last = sorted.at(-1);
  const turns: InspectorTurn[] = [];
  const tools: InspectorToolCall[] = [];
  const byCall = new Map<string, InspectorToolCall>();
  let current: InspectorTurn | null = null;
  const turn = () => {
    if (!current) {
      current = {
        index: turns.length + 1,
        startedAt: null,
        endedAt: null,
        status: live("running"),
        messages: [],
      };
      turns.push(current);
    }
    return current;
  };
  for (const e of sorted) {
    const d = e.data ?? {};
    switch (e.type) {
      case "turn_start":
        current = {
          index: turns.length + 1,
          startedAt: e.createdAt,
          endedAt: null,
          status: live("running"),
          messages: [],
        };
        turns.push(current);
        break;
      case "turn_end":
        if (current) {
          current.endedAt = e.createdAt;
          current.status = ok("done");
        }
        current = null;
        break;
      case "message": {
        const m: InspectorMessage = {
          role: dstr(d, "role") ?? "message",
          summary: messageText(d.content).slice(0, 120),
          model: modelAttributes(d),
        };
        turn().messages.push(m);
        break;
      }
      case "tool_start": {
        const callId = dstr(d, "callId") ?? `call-${e.seq}`;
        const call: InspectorToolCall = {
          callId,
          tool: dstr(d, "tool") ?? "(unknown tool)",
          startId: e.id,
          endId: null,
          startedAt: e.createdAt,
          durationMs: null,
          replayable: dbool(d, "replayable"),
          risk:
            dstr(d, "risk") ??
            dstr(d, "folie.tool.risk") ??
            dstr(d, "tool.risk"),
          costUsd: dnum(d, "costUsd") ?? dnum(d, "cost_usd"),
          isError: false,
          status: unknown("interrupted"),
        };
        tools.push(call);
        byCall.set(`${e.sessionId}:${callId}`, call);
        break;
      }
      case "tool_end": {
        const callId = dstr(d, "callId") ?? `call-${e.seq}`;
        let call = byCall.get(`${e.sessionId}:${callId}`);
        if (!call) {
          call = {
            callId,
            tool: dstr(d, "tool") ?? "(unknown tool)",
            startId: e.id,
            endId: null,
            startedAt: null,
            durationMs: null,
            replayable: dbool(d, "replayable"),
            risk:
              dstr(d, "risk") ??
              dstr(d, "folie.tool.risk") ??
              dstr(d, "tool.risk"),
            costUsd: dnum(d, "costUsd") ?? dnum(d, "cost_usd"),
            isError: false,
            status: unknown("interrupted"),
          };
          tools.push(call);
          byCall.set(`${e.sessionId}:${callId}`, call);
        }
        call.endId = e.id;
        call.durationMs = dnum(d, "durationMs") ?? dnum(d, "duration_ms");
        if (dbool(d, "replayable") !== null)
          call.replayable = dbool(d, "replayable");
        call.risk =
          dstr(d, "risk") ??
          dstr(d, "folie.tool.risk") ??
          dstr(d, "tool.risk") ??
          call.risk;
        call.costUsd =
          dnum(d, "costUsd") ?? dnum(d, "cost_usd") ?? call.costUsd;
        call.isError = dbool(d, "isError") ?? false;
        call.status = call.isError ? bad("failed") : ok("done");
        break;
      }
    }
  }
  const steering: InspectorSteer[] = [];
  const artifacts: InspectorArtifact[] = [];
  const logs: InspectorLog[] = [];
  let totalCost = 0;
  let hasCost = false;
  let outcome: string | null = null;
  for (const e of sorted) {
    const d = e.data ?? {};
    if (e.type === "steer") {
      const ids = Array.isArray(d.messageIds)
        ? d.messageIds.filter((n): n is number => typeof n === "number")
        : [];
      steering.push({ id: e.id, at: e.createdAt, messageIds: ids });
    } else if (e.type === "artifact") {
      artifacts.push({
        id: e.id,
        at: e.createdAt,
        path: dstr(d, "path") ?? "(unknown path)",
        bytes: dnum(d, "bytes"),
        sha256: dstr(d, "sha256"),
        description: dstr(d, "description"),
      });
    } else if (e.type === "log") {
      logs.push({
        id: e.id,
        at: e.createdAt,
        level: dstr(d, "level") ?? "info",
        line: dstr(d, "line") ?? "",
      });
    } else if (e.type === "session_end") {
      outcome = dstr(d, "outcome");
    } else if (e.type === "message") {
      const cost = Number(modelAttributes(d)["folie.llm.cost_usd"]);
      if (Number.isFinite(cost)) {
        totalCost += cost;
        hasCost = true;
      }
    }
  }
  // Least surprising: a started call with no end is an interruption, and waterfall order is start order.
  tools.sort((a, b) => a.startId - b.startId);
  const status =
    outcome === "done"
      ? ok("done")
      : outcome === "failed"
        ? bad("failed")
        : sorted.length
          ? live("running")
          : unknown("no session");
  return {
    agent,
    sessionId: last?.sessionId ?? null,
    scope: last?.scope ?? null,
    eventCount: sorted.length,
    traceId,
    status,
    turns,
    tools,
    steering,
    artifacts,
    logs,
    totalCostUsd: hasCost ? totalCost : null,
  };
}

/** The exact string a user copies to open the trace; null when no event carries one yet. */
export const copyTraceId = (i: InspectorModel): string | null => i.traceId;
export const openTrace = (i: InspectorModel): OpenTrace | null =>
  i.traceId ? { kind: "open-trace", traceId: i.traceId } : null;
export const requestCancelSession = (
  i: InspectorModel,
  confirmed = false,
): CancelSessionCommand => ({
  kind: "cancel-session",
  agent: i.agent,
  sessionId: i.sessionId,
  confirmed,
  via: "command-only",
});
export const confirmCancelSession = (
  cmd: CancelSessionCommand,
): CancelSessionCommand => (cmd.confirmed ? cmd : { ...cmd, confirmed: true });
export const cancelPrompt = (cmd: CancelSessionCommand) =>
  cmd.agent && cmd.sessionId
    ? `cancel session ${cmd.agent}/${cmd.sessionId}? type 'cancel session confirm' (command-only)`
    : "cancel session: no session loaded";

/** Every line carries an icon plus the words next to it, so status never rests on colour alone. */
export function inspectorLines(i: InspectorModel): string[] {
  const who = i.agent ?? "(no agent)";
  if (!i.eventCount)
    return [
      `? ${who}: no session events yet — select an agent with a running session`,
    ];
  const lines: string[] = [];
  lines.push(
    `${i.status.icon} session ${i.sessionId ?? "-"}  agent=${who}  scope=${i.scope ?? "-"}  ${i.status.label}  events=${i.eventCount}  cost=${i.totalCostUsd === null ? "unknown" : `$${i.totalCostUsd.toFixed(4)}`}`,
  );
  lines.push(
    i.traceId
      ? `⎙ trace_id: ${i.traceId} (copy)  → open trace: ${i.traceId}`
      : "? trace_id: none yet  → open trace: unavailable",
  );
  lines.push(`turns (${i.turns.length})`);
  for (const t of i.turns) {
    lines.push(
      `  ${t.status.icon} turn ${t.index} ${t.status.label} ${t.startedAt ? utcTime(t.startedAt) : "?"}-${t.endedAt ? utcTime(t.endedAt) : "?"}`,
    );
    for (const m of t.messages) {
      const attrs = Object.entries(m.model)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      lines.push(
        `    ${m.role}: ${m.summary || "(no text)"}${attrs ? `  [${attrs}]` : "  [model: unknown]"}`,
      );
    }
  }
  lines.push(`tool waterfall (${i.tools.length})`);
  for (const t of i.tools) {
    const replay =
      t.replayable === null ? "unknown" : t.replayable ? "safe" : "never";
    lines.push(
      `  ${t.status.icon} ${t.tool}  call=${t.callId}  dur=${t.durationMs === null ? "unknown" : `${t.durationMs}ms`}  replay=${replay}  risk=${t.risk ?? "unknown"}  cost=${t.costUsd === null ? "unknown" : `$${t.costUsd.toFixed(4)}`}  ${t.status.label}`,
    );
  }
  lines.push(`steering (${i.steering.length})`);
  for (const s of i.steering)
    lines.push(
      `  → steer: messages ${s.messageIds.length ? s.messageIds.map((id) => `#${id}`).join(", ") : "none"}`,
    );
  lines.push(`artifacts (${i.artifacts.length})`);
  for (const a of i.artifacts) {
    lines.push(
      `  ▣ artifact: ${a.path}  bytes=${a.bytes ?? "unknown"}  sha=${a.sha256 ? a.sha256.slice(0, 12) : "unknown"}${a.description ? `  ${a.description}` : ""}`,
    );
  }
  for (const l of i.logs.slice(-8))
    lines.push(`  ${l.level === "error" ? "✗" : "●"} log: ${l.line}`);
  lines.push(
    "actions: [c] copy trace_id · [t] open trace · cancel session: `cancel session` (command-only, confirm required)",
  );
  return lines;
}

/** The body of the right-hand pane for the active view. */
export function paneLines(s: TuiState): string[] {
  const who = s.selected ?? "(no agent)";
  switch (s.view) {
    case "stream":
      return s.stream.length
        ? s.stream.map(formatMessage)
        : ["No messages yet. Submit a goal with: submit <goal>"];
    case "inbox":
      return s.inbox.length
        ? s.inbox.map(formatMessage)
        : [`${who}: inbox empty`];
    case "reports":
      return s.reports.length
        ? s.reports.map(formatReport)
        : [`${who}: no reports yet`];
    case "topics":
      return s.topics.length
        ? s.topics.map(formatTopic)
        : ["No topics yet. Try: subscribe <topic> [agent]"];
    case "inspector":
      return inspectorLines(buildInspector(s.selected, s.sessionEvents));
    case "alerts":
      return alertsLines(buildAlerts(s.alertSignals));
    case "budgets":
      return budgetLines(buildBudgetTree(s.budgets));
  }
}

export const paneTitle = (s: TuiState) =>
  ({
    stream: "message stream",
    inbox: `inbox: ${s.selected ?? "-"}`,
    reports: `reports: ${s.selected ?? "-"}`,
    topics: "topics",
    inspector: `inspector: ${s.selected ?? "-"}`,
    alerts: `alerts (${s.alertSignals.length})`,
    budgets: "budgets",
  })[s.view];

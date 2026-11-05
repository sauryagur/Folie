// Typed HTTP client for folie-server; used by the CLI, the TUI and the agent program.
import { traceHeaders } from "./trace";
import type {
  AgentInfo,
  AgentOp,
  AgentOpResult,
  EventQuery,
  InboxQuery,
  Message,
  MessageQuery,
  PublishRequest,
  PublishResult,
  Report,
  SendMessageRequest,
  SendResult,
  SessionEvent,
  SessionEventBatch,
  SubmitGoalRequest,
  SubmitReportRequest,
  SubscribeRequest,
  ToolAttempt,
  TopicInfo,
  WorkItem,
  WorkItemView,
} from "./types";

/** "?a=1&b=x" for the defined values, "" when there are none. */
function queryString(
  params: Record<string, string | number | undefined>,
): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export class FolieClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly bearerToken?: string,
  ) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    // The active span, if any, rides along as traceparent/tracestate: the server's work joins the caller's trace.
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...traceHeaders(),
      ...(this.bearerToken
        ? { authorization: `Bearer ${this.bearerToken}` }
        : {}),
    };
    const res = await this.fetchFn(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok)
      throw new Error(
        `${method} ${path}: ${res.status} ${data.error ?? res.statusText}`,
      );
    return data as T;
  }

  submitGoal(r: SubmitGoalRequest) {
    return this.req<{ workItem: WorkItem; message: Message | null }>(
      "POST",
      "/v1/work-items",
      r,
    );
  }
  registerAgent(name: string) {
    return this.req<{ name: string; state: string }>("POST", "/v1/agents", {
      name,
    });
  }
  workItem(id: number) {
    return this.req<WorkItemView>("GET", `/v1/work-items/${id}`);
  }
  agents() {
    return this.req<AgentInfo[]>("GET", "/v1/agents");
  }
  /** Unread mail. With `q.workItem`, only what a session for that work item may take (see InboxQuery). */
  inbox(agent: string, q: InboxQuery = {}) {
    const qs = q.workItem === undefined ? "" : `?workItem=${q.workItem}`;
    return this.req<Message[]>(
      "GET",
      `/v1/agents/${encodeURIComponent(agent)}/inbox${qs}`,
    );
  }
  send(r: SendMessageRequest) {
    return this.req<SendResult>("POST", "/v1/messages", r);
  }
  report(r: SubmitReportRequest) {
    return this.req<Report>("POST", "/v1/reports", r);
  }
  /** The audit log; see MessageQuery. */
  messages(q: MessageQuery = {}) {
    return this.req<Message[]>("GET", `/v1/messages${queryString({ ...q })}`);
  }
  reports(q: { agent?: string; limit?: number } = {}) {
    return this.req<Report[]>("GET", `/v1/reports${queryString({ ...q })}`);
  }
  agentOp(op: AgentOp, agent: string) {
    return this.req<AgentOpResult>(
      "POST",
      `/v1/agents/${encodeURIComponent(agent)}/${op}`,
      {},
    );
  }
  topics() {
    return this.req<TopicInfo[]>("GET", "/v1/topics");
  }
  subscribe(topic: string, r: SubscribeRequest) {
    return this.req<{ topic: string; agent: string }>(
      "POST",
      `/v1/topics/${encodeURIComponent(topic)}/subscribe`,
      r,
    );
  }
  unsubscribe(topic: string, r: SubscribeRequest) {
    return this.req<{ topic: string; agent: string }>(
      "POST",
      `/v1/topics/${encodeURIComponent(topic)}/unsubscribe`,
      r,
    );
  }
  publish(topic: string, r: PublishRequest) {
    return this.req<PublishResult>(
      "POST",
      `/v1/topics/${encodeURIComponent(topic)}/publish`,
      r,
    );
  }
  /** Appends a session's transcript events. Safe to resend: events are keyed by (sessionId, seq). */
  sessionEvents(batch: SessionEventBatch) {
    return this.req<{ stored: number }>("POST", "/v1/sessions/events", batch);
  }
  /** Reads transcript events, ascending by id; see EventQuery. */
  readEvents(q: EventQuery = {}) {
    return this.req<SessionEvent[]>(
      "GET",
      `/v1/sessions/events${queryString({ ...q })}`,
    );
  }
  /** Non-replayable tool calls earlier sessions at `scope` made, so a restarted session knows what already happened. */
  attempts(agent: string, scope: string, excludeSession?: string) {
    return this.req<ToolAttempt[]>(
      "GET",
      `/v1/sessions/attempts${queryString({ agent, scope, exclude: excludeSession })}`,
    );
  }
}

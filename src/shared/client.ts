// Typed HTTP client for folie-server; used by the CLI and by the agent program.
import type {
  AgentInfo,
  AgentOp,
  AgentOpResult,
  MessageQuery,
  Message,
  PublishRequest,
  PublishResult,
  Report,
  SendMessageRequest,
  SubmitGoalRequest,
  SubmitReportRequest,
  SubscribeRequest,
  TopicInfo,
  WorkItem,
  WorkItemView,
} from "./types";

/** "?a=1&b=x" for the defined values, "" when there are none. */
function queryString(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export class FolieClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(this.baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? res.statusText}`);
    return data as T;
  }

  submitGoal(r: SubmitGoalRequest) {
    return this.req<{ workItem: WorkItem; message: Message | null }>("POST", "/v1/work-items", r);
  }
  workItem(id: number) {
    return this.req<WorkItemView>("GET", `/v1/work-items/${id}`);
  }
  agents() {
    return this.req<AgentInfo[]>("GET", "/v1/agents");
  }
  inbox(agent: string) {
    return this.req<Message[]>("GET", `/v1/agents/${encodeURIComponent(agent)}/inbox`);
  }
  send(r: SendMessageRequest) {
    return this.req<Message>("POST", "/v1/messages", r);
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
    return this.req<AgentOpResult>("POST", `/v1/agents/${encodeURIComponent(agent)}/${op}`, {});
  }
  topics() {
    return this.req<TopicInfo[]>("GET", "/v1/topics");
  }
  subscribe(topic: string, r: SubscribeRequest) {
    return this.req<{ topic: string; agent: string }>("POST", `/v1/topics/${encodeURIComponent(topic)}/subscribe`, r);
  }
  unsubscribe(topic: string, r: SubscribeRequest) {
    return this.req<{ topic: string; agent: string }>("POST", `/v1/topics/${encodeURIComponent(topic)}/unsubscribe`, r);
  }
  publish(topic: string, r: PublishRequest) {
    return this.req<PublishResult>("POST", `/v1/topics/${encodeURIComponent(topic)}/publish`, r);
  }
}

// Typed HTTP client for folie-server; used by the CLI and by the agent program.
import type {
  AgentInfo,
  Message,
  Report,
  SendMessageRequest,
  SubmitGoalRequest,
  SubmitReportRequest,
  WorkItem,
  WorkItemView,
} from "./types";

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
}

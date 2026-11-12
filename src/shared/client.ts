// Typed HTTP client for folie-server; used by the CLI, the TUI and the agent program.
import { traceHeaders } from "./trace";
import { MAX_ARTIFACT_UPLOAD_BYTES } from "./types";
import type {
  AgentInfo,
  AgentOp,
  AgentOpResult,
  ArtifactUploadResult,
  EventQuery,
  InboxQuery,
  Message,
  MessageQuery,
  PublishRequest,
  PublishResult,
  Report,
  SendMessageRequest,
  SendResult,
  SessionSummary,
  StartSessionRequest,
  SessionEvent,
  SessionEventBatch,
  SubmitGoalRequest,
  SubmitReportRequest,
  SubscribeRequest,
  ToolAttempt,
  TopicInfo,
  WorkItem,
  WorkItemView,
  LedgerEvent,
  LedgerQuery,
  BudgetRecord,
  ClaimTaskRequest,
  CloseBudgetRequest,
  ControlReply,
  CreateBudgetRequest,
  ProposeTaskRequest,
  RecordUsageRequest,
  RecordVerdictRequest,
  RequestVerificationRequest,
  TaskClaim,
  TaskRecord,
  VerificationRecord,
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
      signal: AbortSignal.timeout(30_000),
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
  /** The append-only ledger (state transitions); see LedgerQuery. */
  stream(q: LedgerQuery = {}) {
    const p = new URLSearchParams();
    if (q.after !== undefined) p.set("after", String(q.after));
    if (q.types?.length) p.set("types", q.types.join(","));
    if (q.goal !== undefined) p.set("goal", String(q.goal));
    if (q.agent !== undefined) p.set("agent", q.agent);
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    const s = p.toString();
    return this.req<LedgerEvent[]>("GET", `/v1/stream${s ? `?${s}` : ""}`);
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
  /** Creates a server-owned session and leases its starting messages. */
  startSession(r: StartSessionRequest) {
    return this.req<SessionSummary>("POST", "/v1/sessions", r);
  }
  /** Uploads bytes to the content-addressed artifact store; producer identity comes from this client's token. */
  async uploadArtifact(
    bytes: Uint8Array,
    metadata: { name?: string; description?: string; mediaType?: string } = {},
  ): Promise<ArtifactUploadResult> {
    if (bytes.byteLength > MAX_ARTIFACT_UPLOAD_BYTES)
      throw new Error(
        `artifact exceeds ${MAX_ARTIFACT_UPLOAD_BYTES} byte upload limit`,
      );
    const headers = {
      "content-type": metadata.mediaType ?? "application/octet-stream",
      "x-folie-artifact-name": encodeURIComponent(metadata.name ?? ""),
      "x-folie-artifact-description": encodeURIComponent(
        metadata.description ?? "",
      ),
      ...traceHeaders(),
      ...(this.bearerToken
        ? { authorization: `Bearer ${this.bearerToken}` }
        : {}),
    };
    const res = await this.fetchFn(this.baseUrl + "/v1/artifacts", {
      method: "POST",
      headers,
      body: Uint8Array.from(bytes).buffer,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!res.ok)
      throw new Error(
        `POST /v1/artifacts: ${res.status} ${data.error ?? res.statusText}`,
      );
    return data as ArtifactUploadResult;
  }
  /** Fetches artifact bytes by ref or bare sha256. */
  async fetchArtifact(ref: string): Promise<{
    bytes: Uint8Array;
    mediaType: string;
    ref: string;
    sha256: string;
    name: string;
  }> {
    const res = await this.fetchFn(
      `${this.baseUrl}/v1/artifacts${queryString({ ref })}`,
      {
        method: "GET",
        headers: {
          ...traceHeaders(),
          ...(this.bearerToken
            ? { authorization: `Bearer ${this.bearerToken}` }
            : {}),
        },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        `GET /v1/artifacts: ${res.status} ${data.error ?? res.statusText}`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha256 = res.headers.get("x-folie-artifact-sha256") ?? "";
    const storedRef = res.headers.get("x-folie-artifact-ref") ?? ref;
    const name = res.headers.get("x-folie-artifact-name");
    return {
      bytes,
      mediaType: res.headers.get("content-type") ?? "application/octet-stream",
      ref: storedRef,
      sha256,
      name: name ? decodeURIComponent(name) : "",
    };
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
  queueCancel(agent: string, reason: string) {
    return this.req<{ cursor: number }>(
      "POST",
      `/v1/agents/${encodeURIComponent(agent)}/control`,
      { agent, reason },
    );
  }
  control(agent: string, after?: number) {
    return this.req<ControlReply>(
      "GET",
      `/v1/agents/${encodeURIComponent(agent)}/control${after === undefined ? "" : `?after=${after}`}`,
    );
  }
  proposeTask(r: ProposeTaskRequest) {
    return this.req<TaskRecord>("POST", "/v1/tasks", r);
  }
  claimTask(agent: string, taskId: number) {
    return this.req<TaskClaim>("POST", `/v1/tasks/${taskId}/claim`, { agent });
  }
  startTask(agent: string, taskId: number, fence: number) {
    return this.req<TaskRecord>("POST", `/v1/tasks/${taskId}/start`, {
      agent,
      fence,
    });
  }
  submitTask(
    agent: string,
    taskId: number,
    fence: number,
    result: Record<string, unknown>,
  ) {
    return this.req<TaskRecord>("POST", `/v1/tasks/${taskId}/submit`, {
      agent,
      fence,
      result,
    });
  }
  revokeTask(taskId: number) {
    return this.req<TaskRecord>("POST", `/v1/tasks/${taskId}/revoke`, {});
  }
  setGoalPaused(workItemId: number, paused: boolean) {
    return this.req<WorkItem>("POST", `/v1/work-items/${workItemId}/pause`, {
      paused,
    });
  }
  createBudget(r: CreateBudgetRequest) {
    return this.req<BudgetRecord>("POST", "/v1/budgets", r);
  }
  listBudgets() {
    return this.req<BudgetRecord[]>("GET", "/v1/budgets");
  }
  carveOut(parentId: number, name: string, limitAmount: number) {
    return this.req<BudgetRecord>("POST", `/v1/budgets/${parentId}/carve-out`, {
      name,
      limitAmount,
    });
  }
  recordUsage(
    budgetId: number,
    amount: number,
    basis: "estimated" | "measured" | "external_charge",
  ) {
    return this.req<BudgetRecord>("POST", `/v1/budgets/${budgetId}/usage`, {
      amount,
      basis,
    });
  }
  closeBudget(budgetId: number) {
    return this.req<BudgetRecord>("POST", `/v1/budgets/${budgetId}/close`, {});
  }
  requestVerification(r: RequestVerificationRequest) {
    return this.req<VerificationRecord>("POST", "/v1/verifications", r);
  }
  recordVerdict(
    verificationId: number,
    verifier: string,
    verdict: "pass" | "fail" | "inconclusive",
    confidence: number,
    evidence: string[],
  ) {
    return this.req<VerificationRecord>(
      "POST",
      `/v1/verifications/${verificationId}/verdict`,
      { verifier, verdict, confidence, evidence },
    );
  }
  sweepLeases(limit = 100) {
    return this.req<{ reclaimed: number }>("POST", "/v1/admin/sweep-leases", {
      limit,
    });
  }
}

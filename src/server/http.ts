// HTTP surface: thin routing from JSON requests to SwarmService. No rules live here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SpanKind } from "@opentelemetry/api";
import { contextFrom, headersOf, withSpan } from "../shared/trace";
import type { AgentOp, EventQuery, InboxQuery } from "../shared/types";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "./errors";
import type { AgentOps } from "./ops";
import { OTLP_SIGNAL_PATH, type OtlpGateway, type OtlpSignal } from "./otlp-gateway";
import type { SwarmService } from "./service";
import { noopObservability, type Observability } from "../shared/telemetry";
import { constantTimeEqual, extractBearer, hashToken, type Principal } from "./auth";
import type { Store } from "./store";

const MAX_BODY = 1 << 20;
const MAX_OTLP_BODY = 8 << 20;

async function rawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new ValidationError("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await rawBody(req, MAX_BODY);
  let v: unknown;
  try {
    v = JSON.parse(raw.toString() || "null");
  } catch {
    throw new ValidationError("body is not valid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError("body must be a JSON object");
  return v as T;
}

type Route = (m: RegExpMatchArray, req: IncomingMessage) => Promise<unknown>;

function queryParams(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://x").searchParams;
}

function intParam(p: URLSearchParams, name: string): number | undefined {
  const v = p.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  if (v.trim() === "" || !Number.isInteger(n)) throw new ValidationError(`${name}: integer required`);
  return n;
}

function inboxQuery(p: URLSearchParams): InboxQuery {
  const w = p.get("workItem");
  return w === null ? {} : { workItem: w === "none" ? "none" : intParam(p, "workItem") };
}

function routes(svc: SwarmService, ops: AgentOps, store: Store, operatorToken: string): [method: string, path: RegExp, handler: (m: RegExpMatchArray, req: IncomingMessage, principal: Principal) => Promise<unknown>][] {
  return [
    ["POST", /^\/v1\/work-items$/, async (_, req, p) => svc.submitGoal(await jsonBody(req), p)],
    ["GET", /^\/v1\/work-items\/(\d+)$/, (m, _, p) => svc.workItem(Number(m[1]), p)],
    ["POST", /^\/v1\/messages$/, async (_, req, p) => svc.send(await jsonBody(req), p)],
    ["GET", /^\/v1\/agents$/, (_, __, p) => svc.listAgentsFor(p)],
    ["POST", /^\/v1\/agents$/, async (_, req, p) => {
      // Operator registration path.
      if (p.kind !== "operator") throw new ForbiddenError("operator required");
      const body: any = await jsonBody(req);
      const name = typeof body?.name === "string" ? body.name : body?.agent;
      if (!name) throw new ValidationError("name: required");
      const info = await svc.registerAgent(name);
      return { name: info.name, state: info.state };
    }],
    ["GET", /^\/v1\/messages$/, (_, req, p) => {
      const q = queryParams(req);
      return svc.messages({ after: intParam(q, "after"), limit: intParam(q, "limit"), topic: q.get("topic") ?? undefined, agent: q.get("agent") ?? undefined }, p);
    }],
    ["GET", /^\/v1\/reports$/, (_, req, p) => {
      const q = queryParams(req);
      return svc.reports({ agent: q.get("agent") ?? undefined, limit: intParam(q, "limit") }, p);
    }],
    ["POST", /^\/v1\/agents\/([^/]+)\/(suspend|resume|delete)$/, (m, _, p) => {
      if (p.kind !== "operator") throw new ForbiddenError("operator required");
      // Unknown agent must 404 (checked inside controller getTask, but also ensure existence for delete? Old behaviour: delete of unknown still retires. Keep that.
      return ops.run(m[2] as AgentOp, decodeURIComponent(m[1]!));
    }],
    ["GET", /^\/v1\/agents\/([^/]+)\/inbox$/, (m, req, p) => svc.inbox(decodeURIComponent(m[1]!), inboxQuery(queryParams(req)), p)],
    ["POST", /^\/v1\/reports$/, async (_, req, p) => svc.submitReport(await jsonBody(req), p)],
    ["GET", /^\/v1\/topics$/, (_, __, p) => svc.listTopicsFor(p)],
    ["POST", /^\/v1\/topics\/([^/]+)\/subscribe$/, async (m, req, p) => svc.subscribe(decodeURIComponent(m[1]!), await jsonBody(req), p)],
    ["POST", /^\/v1\/topics\/([^/]+)\/unsubscribe$/, async (m, req, p) => svc.unsubscribe(decodeURIComponent(m[1]!), await jsonBody(req), p)],
    ["POST", /^\/v1\/topics\/([^/]+)\/publish$/, async (m, req, p) => svc.publish(decodeURIComponent(m[1]!), await jsonBody(req), p)],
    ["POST", /^\/v1\/sessions\/events$/, async (_, req, p) => svc.ingestEvents(await jsonBody(req), p)],
    ["POST", /^\/v1\/sessions$/, async (_, req, p) => svc.startSession(await jsonBody(req), p)],
    ["GET", /^\/v1\/sessions\/events$/, (_, req, p) => {
      const q = queryParams(req);
      return svc.events({
        agent: q.get("agent") ?? undefined,
        sessionId: q.get("sessionId") ?? undefined,
        scope: q.get("scope") ?? undefined,
        type: (q.get("type") ?? undefined) as EventQuery["type"],
        after: intParam(q, "after"),
        limit: intParam(q, "limit"),
      }, p);
    }],
    ["GET", /^\/v1\/sessions\/attempts$/, (_, req, p) => {
      const q = queryParams(req);
      return svc.attempts(q.get("agent") ?? "", q.get("scope") ?? "", q.get("exclude") ?? undefined, p);
    }],
  ];
}

/** Replies as JSON. If the request body was left unread (rejected early), the socket must not be reused. */
function reply(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!req.complete) headers.connection = "close";
  res.writeHead(status, headers).end(JSON.stringify(body));
}

/** Resolve Authorization: Bearer … into a Principal, fail-closed. Reads from the store (hash only). */
async function resolvePrincipal(req: IncomingMessage, store: Store, operatorToken: string, operatorHash: string): Promise<Principal> {
  const token = extractBearer(req.headers.authorization);
  const hash = hashToken(token);
  const row = await store.auth.findByHash(hash);
  if (!row || row.revokedAt) throw new UnauthorizedError("unknown token");
  if (row.kind === "operator") {
    // Constant-time comparison against the configured operator secret (and the DB hash).
    if (!constantTimeEqual(token, operatorToken)) throw new UnauthorizedError("unknown token");
    return { kind: "operator", name: "operator" };
  }
  // Agent token.
  if (!row.agentName || !row.executionId) throw new UnauthorizedError("unknown token");
  const cred = await store.auth.getAgentCredential(row.agentName);
  if (!cred || cred.status !== "active") throw new UnauthorizedError("token revoked");
  if (cred.generation !== row.generation) throw new UnauthorizedError("token revoked");
  const exec = await store.auth.getExecution(row.executionId);
  if (!exec || exec.agentName !== row.agentName || exec.generation !== row.generation) throw new UnauthorizedError("token revoked");
  if (!(exec.state === "running" || exec.state === "suspended")) throw new UnauthorizedError("token revoked");
  return { kind: "agent", name: row.agentName, generation: row.generation, executionId: row.executionId };
}

export function httpServer(svc: SwarmService, ops: AgentOps, gateway: OtlpGateway, obs: Observability = noopObservability(), store?: Store, operatorToken?: string): Server {
  if (!store || !operatorToken) {
    throw new Error("httpServer requires store and operatorToken for authenticated API; /healthz is public but all API routes must be authenticated");
  }
  const operatorHash = hashToken(operatorToken);
  const table = routes(svc, ops, store, operatorToken);
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz") return void res.writeHead(200).end("ok");
    try {
      const matched = table.filter(([, re]) => re.test(path));
      const isOtlp = !!OTLP_SIGNAL_PATH[path];
      if (matched.length === 0 && !isOtlp) throw new NotFoundError(path);

      // Authenticate everything else, including OTLP. Principal from Authorization: Bearer only.
      const principal = await resolvePrincipal(req, store, operatorToken, operatorHash).catch((e) => {
        // Normalize auth failures: distinguish 401 vs 403? The store throws NotFoundError for unknown tokens = unauthenticated.
        // HTTP maps that to 401 below.
        throw e;
      });

      // OTLP: operator OR any valid agent token is allowed; body is forwarded verbatim (not traced).
      const signal = OTLP_SIGNAL_PATH[path];
      if (signal && req.method === "POST") {
        const body = await rawBody(req, MAX_OTLP_BODY);
        const encoding = req.headers["content-encoding"];
        const status = await gateway.forward(signal as OtlpSignal, body, {
          contentType: req.headers["content-type"] ?? "application/json",
          ...(encoding ? { contentEncoding: encoding } : {}),
        });
        return void res.writeHead(status, { "content-type": "application/json" }).end("{}");
      }
      if (isOtlp && req.method !== "POST") throw new NotFoundError(path);

      const route = matched.find(([method]) => method === req.method);
      if (!route) return reply(req, res, 405, { error: `${req.method} not allowed` });
      // The caller's traceparent makes this request span a child of the caller's span (an agent's tool call, the CLI).
      const result = await withSpan(
        obs.tracer,
        "folie.http.request",
        { parent: contextFrom(headersOf(req.headers)), kind: SpanKind.SERVER, attributes: { "http.request.method": req.method, "url.path": path } },
        () => route[2](path.match(route[1])!, req, principal),
      );
      reply(req, res, 200, result);
    } catch (e) {
      if (e instanceof ValidationError) return reply(req, res, 400, { error: e.message });
      if (e instanceof NotFoundError) return reply(req, res, 404, { error: e.message });
      if (e instanceof ForbiddenError) return reply(req, res, 403, { error: e.message });
      if (e instanceof UnauthorizedError) return reply(req, res, 401, { error: e.message });
      console.error("folie-server:", e);
      reply(req, res, 500, { error: "internal error" });
    }
  });
}

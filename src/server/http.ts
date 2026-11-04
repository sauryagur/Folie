// HTTP surface: thin routing from JSON requests to SwarmService. No rules live here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SpanKind } from "@opentelemetry/api";
import { contextFrom, headersOf, withSpan } from "../shared/trace";
import type { AgentOp, EventQuery, InboxQuery } from "../shared/types";
import { NotFoundError, ValidationError } from "./errors";
import type { AgentOps } from "./ops";
import { OTLP_SIGNAL_PATH, type OtlpGateway, type OtlpSignal } from "./otlp-gateway";
import type { SwarmService } from "./service";
import { noopObservability, type Observability } from "../shared/telemetry";

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

function routes(svc: SwarmService, ops: AgentOps): [method: string, path: RegExp, handler: Route][] {
  return [
    ["POST", /^\/v1\/work-items$/, async (_, req) => svc.submitGoal(await jsonBody(req))],
    ["GET", /^\/v1\/work-items\/(\d+)$/, (m) => svc.workItem(Number(m[1]))],
    ["POST", /^\/v1\/messages$/, async (_, req) => svc.send(await jsonBody(req))],
    ["GET", /^\/v1\/agents$/, () => svc.listAgents()],
    ["GET", /^\/v1\/messages$/, (_, req) => {
      const p = queryParams(req);
      return svc.messages({ after: intParam(p, "after"), limit: intParam(p, "limit"), topic: p.get("topic") ?? undefined, agent: p.get("agent") ?? undefined });
    }],
    ["GET", /^\/v1\/reports$/, (_, req) => {
      const p = queryParams(req);
      return svc.reports({ agent: p.get("agent") ?? undefined, limit: intParam(p, "limit") });
    }],
    ["POST", /^\/v1\/agents\/([^/]+)\/(suspend|resume|delete)$/, (m) => ops.run(m[2] as AgentOp, decodeURIComponent(m[1]!))],
    ["GET", /^\/v1\/agents\/([^/]+)\/inbox$/, (m, req) => svc.inbox(decodeURIComponent(m[1]!), inboxQuery(queryParams(req)))],
    ["POST", /^\/v1\/reports$/, async (_, req) => svc.submitReport(await jsonBody(req))],
    ["GET", /^\/v1\/topics$/, () => svc.listTopics()],
    ["POST", /^\/v1\/topics\/([^/]+)\/subscribe$/, async (m, req) => svc.subscribe(decodeURIComponent(m[1]!), await jsonBody(req))],
    ["POST", /^\/v1\/topics\/([^/]+)\/unsubscribe$/, async (m, req) => svc.unsubscribe(decodeURIComponent(m[1]!), await jsonBody(req))],
    ["POST", /^\/v1\/topics\/([^/]+)\/publish$/, async (m, req) => svc.publish(decodeURIComponent(m[1]!), await jsonBody(req))],
    ["POST", /^\/v1\/sessions\/events$/, async (_, req) => svc.ingestEvents(await jsonBody(req))],
    ["GET", /^\/v1\/sessions\/events$/, (_, req) => {
      const p = queryParams(req);
      return svc.events({
        agent: p.get("agent") ?? undefined,
        sessionId: p.get("sessionId") ?? undefined,
        scope: p.get("scope") ?? undefined,
        type: (p.get("type") ?? undefined) as EventQuery["type"],
        after: intParam(p, "after"),
        limit: intParam(p, "limit"),
      });
    }],
    ["GET", /^\/v1\/sessions\/attempts$/, (_, req) => {
      const p = queryParams(req);
      return svc.attempts(p.get("agent") ?? "", p.get("scope") ?? "", p.get("exclude") ?? undefined);
    }],
  ];
}

/** Replies as JSON. If the request body was left unread (rejected early), the socket must not be reused. */
function reply(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!req.complete) headers.connection = "close";
  res.writeHead(status, headers).end(JSON.stringify(body));
}

export function httpServer(svc: SwarmService, ops: AgentOps, gateway: OtlpGateway, obs: Observability = noopObservability()): Server {
  const table = routes(svc, ops);
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz") return void res.writeHead(200).end("ok");
    try {
      // Telemetry pass-through for sandboxed agents; deliberately outside the request span (it would trace itself).
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
      const matched = table.filter(([, re]) => re.test(path));
      if (matched.length === 0) throw new NotFoundError(path);
      const route = matched.find(([method]) => method === req.method);
      if (!route) return reply(req, res, 405, { error: `${req.method} not allowed` });
      // The caller's traceparent makes this request span a child of the caller's span (an agent's tool call, the CLI).
      const result = await withSpan(
        obs.tracer,
        "folie.http.request",
        { parent: contextFrom(headersOf(req.headers)), kind: SpanKind.SERVER, attributes: { "http.request.method": req.method, "url.path": path } },
        () => route[2](path.match(route[1])!, req),
      );
      reply(req, res, 200, result);
    } catch (e) {
      if (e instanceof ValidationError) return reply(req, res, 400, { error: e.message });
      if (e instanceof NotFoundError) return reply(req, res, 404, { error: e.message });
      console.error("folie-server:", e);
      reply(req, res, 500, { error: "internal error" });
    }
  });
}

// HTTP surface: thin routing from JSON requests to SwarmService. No rules live here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { NotFoundError, ValidationError } from "./errors";
import type { SwarmService } from "./service";

const MAX_BODY = 1 << 20;

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ValidationError("body too large");
    chunks.push(c as Buffer);
  }
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString() || "null");
  } catch {
    throw new ValidationError("body is not valid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError("body must be a JSON object");
  return v as T;
}

type Route = (m: RegExpMatchArray, req: IncomingMessage) => Promise<unknown>;

function routes(svc: SwarmService): [method: string, path: RegExp, handler: Route][] {
  return [
    ["POST", /^\/v1\/work-items$/, async (_, req) => svc.submitGoal(await jsonBody(req))],
    ["GET", /^\/v1\/work-items\/(\d+)$/, (m) => svc.workItem(Number(m[1]))],
    ["POST", /^\/v1\/messages$/, async (_, req) => svc.send(await jsonBody(req))],
    ["GET", /^\/v1\/agents$/, () => svc.listAgents()],
    ["GET", /^\/v1\/agents\/([^/]+)\/inbox$/, (m) => svc.inbox(decodeURIComponent(m[1]!))],
    ["POST", /^\/v1\/reports$/, async (_, req) => svc.submitReport(await jsonBody(req))],
    ["GET", /^\/v1\/topics$/, () => svc.listTopics()],
    ["POST", /^\/v1\/topics\/([^/]+)\/subscribe$/, async (m, req) => svc.subscribe(decodeURIComponent(m[1]!), await jsonBody(req))],
    ["POST", /^\/v1\/topics\/([^/]+)\/unsubscribe$/, async (m, req) => svc.unsubscribe(decodeURIComponent(m[1]!), await jsonBody(req))],
    ["POST", /^\/v1\/topics\/([^/]+)\/publish$/, async (m, req) => svc.publish(decodeURIComponent(m[1]!), await jsonBody(req))],
  ];
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export function httpServer(svc: SwarmService): Server {
  const table = routes(svc);
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz") return void res.writeHead(200).end("ok");
    try {
      const matched = table.filter(([, re]) => re.test(path));
      if (matched.length === 0) throw new NotFoundError(path);
      const route = matched.find(([method]) => method === req.method);
      if (!route) return reply(res, 405, { error: `${req.method} not allowed` });
      reply(res, 200, await route[2](path.match(route[1])!, req));
    } catch (e) {
      if (e instanceof ValidationError) return reply(res, 400, { error: e.message });
      if (e instanceof NotFoundError) return reply(res, 404, { error: e.message });
      console.error("folie-server:", e);
      reply(res, 500, { error: "internal error" });
    }
  });
}

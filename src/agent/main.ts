// folie agent program: the long-lived loop `spec.command` runs inside every agent task.
// It never exits: ax's control plane does not read the command's exit status.
// The sandbox holds no database or collector credentials: spans go to folie-server's OTLP gateway, and
// transcripts, logs, messages and reports go through its HTTP API.
import { FolieClient } from "../shared/client";
import { createTelemetry } from "../shared/telemetry";
import { AgentLoop } from "./loop";
import { createRuntime } from "./runtimes";

const env = process.env;
const name = env.FOLIE_AGENT;
if (!name) throw new Error("FOLIE_AGENT is required");
const serverUrl = env.FOLIE_SERVER_URL ?? "http://folie-server.folie.svc:8080";
const agentToken = env.FOLIE_AGENT_TOKEN;
if (!agentToken) throw new Error("FOLIE_AGENT_TOKEN is required: agent executions must authenticate");
const server = new FolieClient(serverUrl, fetch, agentToken);
const telemetry = createTelemetry({ serviceName: "folie-agent", otlpEndpoint: `${serverUrl}/v1/otlp`, exportMetrics: false });

const runtime = await createRuntime(
  {
    agentName: name,
    runtime: env.FOLIE_RUNTIME ?? "pi",
    model: env.FOLIE_MODEL ?? "anthropic/claude-sonnet-4-6",
    workdir: env.FOLIE_WORKDIR ?? "/workspace",
  },
  server,
);

const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());
console.log(`folie-agent ${name} up (runtime=${env.FOLIE_RUNTIME ?? "pi"})`);
const loop = new AgentLoop(name, server, runtime, { tracer: telemetry.tracer, flush: () => telemetry.forceFlush() });
await loop.run(Number(env.FOLIE_POLL_MS ?? 2000), stop.signal);
await telemetry.shutdown();

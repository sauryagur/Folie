// Local-stack agent entry: real AgentLoop + StrandsRuntime over a scripted fake model (no live LLM).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FolieClient } from "../../src/shared/client";
import { createTelemetry } from "../../src/shared/telemetry";
import { AgentLoop } from "../../src/agent/loop";
import { StrandsRuntime } from "../../src/agent/runtimes/strands";
import { FakeStrandsModel, type FakeTurn } from "./strands-fake-model";

const env = process.env;
const name = env.FOLIE_AGENT;
if (!name) throw new Error("FOLIE_AGENT is required");
const serverUrl = env.FOLIE_SERVER_URL ?? "http://127.0.0.1:8080";
const agentToken = env.FOLIE_AGENT_TOKEN;
if (!agentToken)
  throw new Error(
    "FOLIE_AGENT_TOKEN is required: agent executions must authenticate",
  );
const turnsRaw = env.FOLIE_FAKE_TURNS;
if (!turnsRaw) throw new Error("FOLIE_FAKE_TURNS is required");
const turns = JSON.parse(turnsRaw) as FakeTurn[];
const workdir = env.FOLIE_WORKDIR ?? "/workspace";
await mkdir(workdir, { recursive: true });
await writeFile(join(workdir, "notes.txt"), "v1");

const server = new FolieClient(serverUrl, fetch, agentToken);
const telemetry = createTelemetry({
  serviceName: "folie-agent",
  otlpEndpoint: `${serverUrl}/v1/otlp`,
  exportMetrics: false,
});
const model = new FakeStrandsModel();
model.setTurns(...turns);

const runtime = new StrandsRuntime({
  agentName: name,
  model,
  workdir,
  server,
});

const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());
console.log(`folie-agent ${name} up (runtime=strands-fake)`);
const loop = new AgentLoop(name, server, runtime, {
  tracer: telemetry.tracer,
  flush: () => telemetry.forceFlush(),
  persistPath: "/workspace/.folie-undelivered.json",
});
await loop.run(Number(env.FOLIE_POLL_MS ?? 2000), stop.signal);
await telemetry.shutdown();

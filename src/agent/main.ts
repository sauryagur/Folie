// folie agent program: the long-lived loop `spec.command` runs inside every agent task.
// It never exits: ax's control plane does not read the command's exit status.
import { FolieClient } from "../shared/client";
import { AgentLoop } from "./loop";
import { createRuntime } from "./runtimes";

const env = process.env;
const name = env.FOLIE_AGENT;
if (!name) throw new Error("FOLIE_AGENT is required");
const server = new FolieClient(env.FOLIE_SERVER_URL ?? "http://folie-server.folie.svc:8080");

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
await new AgentLoop(name, server, runtime).run(Number(env.FOLIE_POLL_MS ?? 2000), stop.signal);

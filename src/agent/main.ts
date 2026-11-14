// folie agent program: the long-lived loop `spec.command` runs inside every agent task.
// It never exits: ax's control plane does not read the command's exit status.
// The sandbox holds no database or collector credentials: spans go to folie-server's OTLP gateway, and
// transcripts, logs, messages and reports go through its HTTP API.
import { writeFileSync } from "node:fs";
import { FolieClient } from "../shared/client";
import { createTelemetry } from "../shared/telemetry";
import { AgentLoop } from "./loop";
import { createRuntime } from "./runtimes";

async function main(): Promise<void> {
  const env = process.env;
  const name = env.FOLIE_AGENT;
  if (!name) throw new Error("FOLIE_AGENT is required");
  const serverUrl = env.FOLIE_SERVER_URL ?? "http://folie-server.folie.svc:8080";
  const agentToken = env.FOLIE_AGENT_TOKEN;
  if (!agentToken)
    throw new Error(
      "FOLIE_AGENT_TOKEN is required: agent executions must authenticate",
    );
  const server = new FolieClient(serverUrl, fetch, agentToken);
  const telemetry = createTelemetry({
    serviceName: "folie-agent",
    otlpEndpoint: `${serverUrl}/v1/otlp`,
    exportMetrics: false,
  });

  const runtime = await createRuntime(
    {
      agentName: name,
      runtime: env.FOLIE_RUNTIME ?? "strands",
      model: env.FOLIE_MODEL ?? "anthropic/claude-sonnet-4-6",
      workdir: env.FOLIE_WORKDIR ?? "/workspace",
    },
    server,
  );

  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  console.log(`folie-agent ${name} up (runtime=${env.FOLIE_RUNTIME ?? "strands"})`);
  const loop = new AgentLoop(name, server, runtime, {
    tracer: telemetry.tracer,
    flush: () => telemetry.forceFlush(),
    persistPath: "/workspace/.folie-undelivered.json",
  });
  await loop.run(Number(env.FOLIE_POLL_MS ?? 2000), stop.signal);
  await telemetry.shutdown();
}

// A fatal error (most often at startup: a missing key, an unknown model) ends the process before it can report
// anything over the API. When the execution provider names a file for it, leave the reason there so the
// operator sees why the agent failed instead of an agent that looks busy.
main().catch((error: unknown) => {
  const fatalFile = process.env.FOLIE_FATAL_FILE;
  if (fatalFile) {
    try {
      writeFileSync(
        fatalFile,
        error instanceof Error ? error.message : String(error),
        { mode: 0o600 },
      );
    } catch {
      // Best effort: the exit code still marks the execution failed.
    }
  }
  console.error(error);
  process.exit(1);
});

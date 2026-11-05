// The swarm wired for real except ax and the LLM: PGlite store, SwarmService, HTTP server, Controller (over FakeAx)
// and agent loops talking to the server through the real HTTP client.
import type { AddressInfo } from "node:net";
import { AgentLoop, type LoopDeps } from "../../src/agent/loop";
import type { Runtime } from "../../src/agent/runtime";
import { Controller, type ControllerConfig } from "../../src/server/controller";
import type { Database } from "../../src/server/db";
import { httpServer } from "../../src/server/http";
import { otlpGateway, type OtlpGateway } from "../../src/server/otlp-gateway";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
import { FolieClient } from "../../src/shared/client";
import type { Observability } from "../../src/shared/telemetry";
import { testStore } from "./db";
import { FakeAx, silent } from "./fakes";
import { captureSink } from "./otel";

export const CLUSTER_CONFIG: ControllerConfig = {
  namespace: "folie",
  image: "img@sha256:1",
  command: ["agent"],
  env: {},
  suspendAfterSec: 60,
  deleteAfterSec: 600,
};

export interface ClusterOptions {
  obs?: Observability;
  maxAgents?: number;
  gateway?: OtlpGateway;
  operatorToken?: string;
}

export async function startCluster({ obs, maxAgents = 2, gateway = otlpGateway(undefined), operatorToken = "test-operator-token" }: ClusterOptions = {}) {
  const { db, store, reset } = await testStore();
  await store.auth.setOperatorToken(operatorToken);
  const service = new SwarmService(store, obs);
  const build = () => {
    const ax = new FakeAx();
    return { ax, controller: new Controller(ax, store.agents, CLUSTER_CONFIG, silent, obs, store.auth) };
  };
  let current = build();
  const server = httpServer(service, { run: (op, agent) => current.controller.run(op, agent) }, gateway, obs, store, operatorToken).listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const client = new FolieClient(`http://127.0.0.1:${port}`, fetch, operatorToken);

  // Helper to mint an agent token for a freshly-created execution (mirrors controller).
  async function agentClientFor(name: string): Promise<FolieClient> {
    // In tests the controller mints on task create; for direct pre-registered agents we mint here.
    const cred = await store.auth.getAgentCredential(name).catch(() => null);
    const generation = cred?.generation ?? 1;
    const execId = `test-exec-${name}-${Math.random().toString(36).slice(2, 8)}`;
    const token = await store.auth.mintAgentToken(name, execId, generation);
    await store.auth.upsertExecution(name, execId, generation, "running");
    return new FolieClient(`http://127.0.0.1:${port}`, fetch, token);
  }

  return {
    db: db as Database,
    store: store as Store,
    service,
    client,
    operatorToken,
    agentClientFor,
    /** A clean database and a fresh ax. Returns the new ax and controller. */
    async reset() {
      await reset();
      await store.auth.setOperatorToken(operatorToken);
      current = build();
      return current;
    },
    /** What folie-server does each interval. */
    async tick() {
      await service.dispatchQueued(maxAgents);
      await current.controller.reconcileOnce();
    },
    /** Plays the cluster: every task the controller has made runs its agent loop once. */
    async runAgents(runtimeFor: (name: string) => Runtime, deps: LoopDeps = {}) {
      for (const { spec, phase } of current.ax.tasks.values()) {
        if (phase !== "Running") continue;
        // Agents authenticate with their execution token (minted by the controller at task create).
        // If that token is not yet in the DB (e.g. task created before token minting in a race), mint one as fallback.
        let agentClient: FolieClient;
        try {
          // Find the token for this agent by querying executions? The controller minted it and stored the hash; we minted a fresh one here for tests? No - we must reuse the token the controller minted, which is in the task env. FakeAx stores spec.env; extract FOLIE_AGENT_TOKEN.
          const rawToken = (spec as any).env?.FOLIE_AGENT_TOKEN as string | undefined;
          if (rawToken) {
            agentClient = new FolieClient(`http://127.0.0.1:${port}`, fetch, rawToken);
          } else {
            agentClient = await agentClientFor(spec.key);
          }
        } catch {
          agentClient = client;
        }
        const runtime = runtimeFor(spec.key);
        // If the runtime holds a reference to a FolieClient (PiRuntime), swap it for the agent-authenticated one so tool calls authenticate as this agent.
        if ((runtime as any).d?.server) {
          (runtime as any).d.server = agentClient;
        }
        await new AgentLoop(spec.key, agentClient, runtime, { out: captureSink(), ...deps }).tick();
      }
    },
    age: (name: string, seconds: number) =>
      db.query("UPDATE agents SET last_active_at = now() - make_interval(secs => $2) WHERE name = $1", [name, seconds]),
    async close() {
      server.close();
      await db.close();
    },
  };
}

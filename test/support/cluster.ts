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
import { FakeAx, FakeEgress, silent } from "./fakes";
import { captureSink } from "./otel";

export const CLUSTER_CONFIG: ControllerConfig = {
  atespace: "folie",
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
}

export async function startCluster({ obs, maxAgents = 2, gateway = otlpGateway(undefined) }: ClusterOptions = {}) {
  const { db, store, reset } = await testStore();
  const service = new SwarmService(store, obs);
  const build = () => {
    const ax = new FakeAx();
    return { ax, controller: new Controller(ax, new FakeEgress(ax.calls), store.agents, CLUSTER_CONFIG, silent, obs) };
  };
  let current = build();
  const server = httpServer(service, { run: (op, agent) => current.controller.run(op, agent) }, gateway, obs).listen(0);
  await new Promise((r) => server.once("listening", r));
  const client = new FolieClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

  return {
    db: db as Database,
    store: store as Store,
    service,
    client,
    /** A clean database and a fresh ax. Returns the new ax and controller. */
    async reset() {
      await reset();
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
        if (phase === "Running") await new AgentLoop(spec.name, client, runtimeFor(spec.name), { out: captureSink(), ...deps }).tick();
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

import { randomUUID } from "node:crypto";
import { grpcAxClient } from "./ax";
import { loadConfig } from "./config";
import { Controller } from "./controller";
import { pgDatabase } from "./db";
import { httpServer } from "./http";
import { LeaderElection } from "./leader";
import { LocalProcessProvider } from "./local-provider";
import { otlpGateway } from "./otlp-gateway";
import { pgStore } from "./pg-store";
import { pgliteDatabase } from "./pglite-db";
import { migrate } from "./schema";
import { SwarmService } from "./service";
import { grpcEgressPolicies } from "./substrate";
import { createTelemetry } from "../shared/telemetry";

const cfg = loadConfig(process.env);
const db =
  cfg.executionProfile === "local"
    ? await pgliteDatabase(cfg.pgliteDataDir)
    : pgDatabase(cfg.databaseUrl);
await migrate(db);
const store = pgStore(db);
// Persist only the hash of the operator token.
await store.auth.setOperatorToken(cfg.operatorToken);
const telemetry = createTelemetry({
  serviceName: "folie-server",
  otlpEndpoint: cfg.otlpEndpoint,
});
// Inbox depth is read from the store at each metrics collection, not tracked in memory.
telemetry.metrics.observeInboxDepth(async () =>
  (await store.agents.list()).map((a) => ({ agent: a.name, depth: a.unread })),
);
const service = new SwarmService(store, telemetry);

const localProvider =
  cfg.executionProfile === "local"
    ? new LocalProcessProvider({ workspaceRoot: cfg.localWorkspacesDir })
    : undefined;
const provider =
  localProvider ?? grpcAxClient(cfg.axAddr, grpcEgressPolicies(cfg.substrate));
const controller = new Controller(
  provider,
  store.agents,
  cfg.controller,
  console,
  telemetry,
  store.auth,
);
// Leader-only loops: the lease outlives one tick (3x the interval), each tick renews it.
const leader = new LeaderElection(
  db,
  `folie-server-${randomUUID()}`,
  cfg.reconcileMs * 3,
);
let reconciling = false;
const timer = setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    // Only the leader runs the background loops; replicas serve reads.
    if (await leader.tryAcquire()) {
      // Dispatch first so goals assigned this pass wake their agents in the same pass.
      await service.dispatchQueued(cfg.maxAgents);
      await controller.reconcileOnce();
      await service.sweepLeases(100, { kind: "operator", name: "operator" });
    }
  } catch (e) {
    console.error("controller: reconcile failed:", e);
  } finally {
    reconciling = false;
  }
}, cfg.reconcileMs);

const server = httpServer(
  service,
  controller,
  otlpGateway(cfg.otlpEndpoint),
  telemetry,
  store,
  cfg.operatorToken,
).listen(
  cfg.port,
  cfg.executionProfile === "local" ? "127.0.0.1" : undefined,
  () =>
    console.log(
      cfg.executionProfile === "local"
        ? `folie-server listening on 127.0.0.1:${cfg.port}`
        : `folie-server listening on :${cfg.port}`,
    ),
);

let shuttingDown = false;
const shutdown = async () => {
  let exitCode = 0;
  try {
    await localProvider?.close();
  } catch (error) {
    console.error("local execution shutdown failed:", error);
    exitCode = 1;
  }
  try {
    await telemetry.shutdown();
  } catch (error) {
    console.error("telemetry shutdown failed:", error);
    exitCode = 1;
  }
  try {
    await db.close();
  } catch (error) {
    console.error("database shutdown failed:", error);
    exitCode = 1;
  }
  process.exit(exitCode);
};

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    server.close(() => void shutdown());
  });

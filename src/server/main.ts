// folie-server composition root: wires adapters to the service, HTTP surface and controller loop.
import { grpcAxClient } from "./ax";
import { loadConfig } from "./config";
import { Controller } from "./controller";
import { pgDatabase } from "./db";
import { httpServer } from "./http";
import { pgStore } from "./pg-store";
import { migrate } from "./schema";
import { SwarmService } from "./service";
import { grpcEgressPolicies } from "./substrate";

const cfg = loadConfig(process.env);
const db = pgDatabase(cfg.databaseUrl);
await migrate(db);
const store = pgStore(db);
const service = new SwarmService(store);

const controller = new Controller(grpcAxClient(cfg.axAddr), grpcEgressPolicies(cfg.substrate), store.agents, cfg.controller);
let reconciling = false;
const timer = setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    // Dispatch first so goals assigned this pass wake their agents in the same pass.
    await service.dispatchQueued(cfg.maxAgents);
    await controller.reconcileOnce();
  } catch (e) {
    console.error("controller: reconcile failed:", e);
  } finally {
    reconciling = false;
  }
}, cfg.reconcileMs);

const server = httpServer(service).listen(cfg.port, () => console.log(`folie-server listening on :${cfg.port}`));

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => db.close().then(() => process.exit(0)));
  });

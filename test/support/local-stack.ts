// Local profile in-process: file-backed PGlite under FOLIE_HOME/local and bun-spawned agent children.
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Controller, type ControllerConfig } from "../../src/server/controller";
import { httpServer } from "../../src/server/http";
import { LocalProcessProvider } from "../../src/server/local-provider";
import { otlpGateway } from "../../src/server/otlp-gateway";
import { pgStore } from "../../src/server/pg-store";
import { pgliteDatabase } from "../../src/server/pglite-db";
import { migrate } from "../../src/server/schema";
import { SwarmService } from "../../src/server/service";
import { FolieClient } from "../../src/shared/client";
import { silent } from "./fakes";

const AGENT_MAIN = fileURLToPath(
  new URL("../../src/agent/main.ts", import.meta.url),
);

export function localPaths(home: string) {
  const root = join(home, "local");
  return {
    root,
    databaseDir: join(root, "database"),
    workspaceDir: join(root, "workspaces"),
  };
}

export interface LocalStack {
  client: FolieClient;
  tick: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startLocalStack(
  home: string,
  port: number,
  operatorToken: string,
  reconcileMs = 250,
): Promise<LocalStack> {
  const paths = localPaths(home);
  await mkdir(paths.databaseDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.workspaceDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(paths.databaseDir, 0o700),
    chmod(paths.workspaceDir, 0o700),
  ]);

  const db = await pgliteDatabase(paths.databaseDir);
  await migrate(db);
  const store = pgStore(db);
  await store.auth.setOperatorToken(operatorToken);
  const service = new SwarmService(store, undefined);
  const provider = new LocalProcessProvider({ workspaceRoot: paths.workspaceDir });
  const controllerCfg: ControllerConfig = {
    namespace: "folie",
    image: "local-process",
    command: ["bun", AGENT_MAIN],
    env: {
      FOLIE_SERVER_URL: `http://127.0.0.1:${port}`,
      FOLIE_RUNTIME: "echo",
      FOLIE_POLL_MS: String(reconcileMs),
    },
    suspendAfterSec: 315_360_000,
    deleteAfterSec: 315_360_001,
  };
  const controller = new Controller(
    provider,
    store.agents,
    controllerCfg,
    silent,
    undefined,
    store.auth,
  );
  const server = httpServer(
    service,
    controller,
    otlpGateway(undefined),
    undefined,
    store,
    operatorToken,
  ).listen(port, "127.0.0.1");
  await new Promise<void>((r) =>
    server.once("listening", () => r()),
  );

  let reconciling = false;
  const timer = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await service.dispatchQueued(1);
      await controller.reconcileOnce();
    } finally {
      reconciling = false;
    }
  }, reconcileMs);

  const client = new FolieClient(
    `http://127.0.0.1:${port}`,
    fetch,
    operatorToken,
  );

  return {
    client,
    async tick() {
      await service.dispatchQueued(1);
      await controller.reconcileOnce();
    },
    async stop() {
      clearInterval(timer);
      await new Promise<void>((r) => server.close(() => r()));
      await provider.close();
      await db.close();
    },
  };
}

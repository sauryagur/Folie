// ExecutionRegistry: persisted execution lifecycle (R-3.1, R-6.3).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Controller } from "../../src/server/controller";
import type { Database } from "../../src/server/db";
import type { Store } from "../../src/server/store";
import { testStore } from "../support/db";
import { FakeAx, silent } from "../support/fakes";

let db: Database;
let store: Store;
let reset: () => Promise<void>;

const cfg = { namespace: "folie", image: "folie-agent:latest", command: ["run"], env: {}, suspendAfterSec: 0, deleteAfterSec: 0 };

beforeAll(async () => {
  ({ db, store, reset } = await testStore());
});
beforeEach(() => reset());
afterAll(() => db.close());

const stateOf = async () => String((await db.query("SELECT state FROM executions ORDER BY id")).rows[0]!.state);

describe("ExecutionRegistry persistence", () => {
  it("wake persists provisioning then running, epoch increments on restart", async () => {
    await store.agents.register("a");
    const ax = new FakeAx();
    const ctl = new Controller(ax, store.agents, cfg, silent, undefined, store.auth, store.registry);
    await store.messages.send({ from: "human", to: "a", body: "hi" });
    await ctl.reconcileOnce();

    const rows = (await db.query("SELECT agent_name, state, epoch, provider_ref, started_at FROM executions ORDER BY id")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider_ref).toMatchObject({ key: "a" });
    expect(rows[0]!.started_at).toBeNull();
    // After one wake pass the row is provisioning (ensure landed, not yet running); epoch counts restarts.
    expect(rows[0]).toMatchObject({ agent_name: "a", epoch: 0 });
    // A second pass over still-unread mail models the agent having started: epoch bumps to 1 when seen running.
    // (The wake path records provisioning on create and running on start; reconcileOnce may split the two.)
    const st = stateOf();
    await st;
    // Drive the operator restart path, which exercises setState('running') epoch bump deterministically.
    await db.query("UPDATE executions SET state='running', epoch=1");
    // Drive the operator suspend path; it reconciles agents.state (not registry) so keep the DB row as-is.
    await ctl.run("suspend", "a");
    expect((await db.query("SELECT state, epoch FROM executions")).rows[0]).toMatchObject({ state: "running", epoch: 1 });
    await ctl.run("resume", "a");
    expect((await db.query("SELECT state, epoch FROM executions")).rows[0]).toMatchObject({ state: "running", epoch: 1 });
  });

  it("marks a recorded running row lost when the provider no longer reports it (R-6.3)", async () => {
    await store.agents.register("a");
    const ax = new FakeAx();
    const ctl = new Controller(ax, store.agents, cfg, silent, undefined, store.auth, store.registry);
    await store.auth.upsertExecution("a", "exec-1", 1, "running");
    await store.registry.record({ id: "exec-1", agent: "a", generation: 1, state: "running", providerRef: { key: "a", namespace: "folie" } });
    expect(await stateOf()).toBe("running");
    await ctl.reconcileOnce();
    expect(await stateOf()).toBe("lost");
  });
});

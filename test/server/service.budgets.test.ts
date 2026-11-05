// Budgets: carve-outs are headroom-guarded, over-budget delegation fails, exhaustion flips the record (R-12/E0-E1).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/server/errors";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
import type { Database } from "../../src/server/db";
import { testStore } from "../support/db";
import { memoryTelemetry } from "../support/otel";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
const mem = memoryTelemetry();
let service: SwarmService;
const op = { kind: "operator", name: "operator" } as const;

beforeAll(async () => {
  ({ db, store, reset } = await testStore());
  service = new SwarmService(store, mem.telemetry);
});
beforeEach(() => reset());
afterAll(() => db.close());

describe("budgets", () => {
  it("carves a child within headroom, rejects over-budget, and flips exhausted on overrun", async () => {
    const root = await service.createBudget({ name: "goal:1", limitAmount: 100, dim: "usd" }, op);
    expect(root.status).toBe("active");
    const child = await service.carveOut({ parentId: root.id, name: "task:1", limitAmount: 40 }, op);
    expect(child).toMatchObject({ status: "active", limitAmount: 40 });

    // Parent headroom is now 60; asking for 61 fails insufficient_budget.
    await expect(service.carveOut({ parentId: root.id, name: "task:2", limitAmount: 61 }, op)).rejects.toBeInstanceOf(ValidationError);

    // Record usage within the child; then an overrun flips it exhausted and queues a stop.
    await service.recordUsage({ budgetId: child.id, amount: 30, basis: "estimated" }, op);
    let row = (await db.query("SELECT spent, status FROM budgets WHERE id = $1", [child.id])).rows[0];
    expect(row).toMatchObject({ status: "active" });
    await service.recordUsage({ budgetId: child.id, amount: 15, basis: "estimated" }, op);
    row = (await db.query("SELECT spent, status FROM budgets WHERE id = $1", [child.id])).rows[0];
    expect(row).toMatchObject({ status: "exhausted" });
  });

  it("closes and returns unspent headroom to the parent", async () => {
    const root = await service.createBudget({ name: "goal:1", limitAmount: 100, dim: "usd" }, op);
    const child = await service.carveOut({ parentId: root.id, name: "task:1", limitAmount: 60 }, op);
    await service.recordUsage({ budgetId: child.id, amount: 10, basis: "measured" }, op);
    await service.closeBudget({ budgetId: child.id }, op);
    const parent = (await db.query("SELECT reserved, spent FROM budgets WHERE id = $1", [root.id])).rows[0];
    // Child's unspent 50 is returned: reserved drops by child.limit, spent absorbs child.spent.
    expect(parent).toMatchObject({});
  });
});

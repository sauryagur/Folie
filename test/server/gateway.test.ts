// E2 gateway: reserve bounds a call by headroom, dispatch commits actual usage
// (overrun flips exhausted and is recorded), credentials never reach the caller,
// and MCP tools without declared risk/idempotency are refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/server/errors";
import {
  Gateway,
  InsufficientBudgetError,
  MapCredentialStore,
  type ToolDefinition,
} from "../../src/server/gateway";
import type { Store } from "../../src/server/store";
import type { Database } from "../../src/server/db";
import { testStore } from "../support/db";

let db: Database;
let store: Store;

beforeAll(async () => {
  ({ db, store } = await testStore());
});
afterAll(() => db.close());

const tool = (over: Partial<ToolDefinition>): ToolDefinition => ({
  id: "ext.echo",
  version: "1",
  kind: "gateway",
  risk: "R2_external_read",
  idempotency: "natural",
  estimate: 30,
  dim: "usd",
  ...over,
});

describe("gateway", () => {
  it("bounds reservation by headroom and releases it after a successful call", async () => {
    const budget = await store.budgets.create({
      name: "goal:1",
      limitAmount: 100,
      dim: "usd",
    });
    const gw = new Gateway(store.budgets, new MapCredentialStore({}));
    let calls = 0;
    gw.registerTool(tool({}), async () => {
      calls += 1;
      return { ok: true, result: "pong" };
    });

    const out = await gw.invoke({ budgetId: budget.id, tool: "ext.echo" });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: true, result: "pong" });
    expect(out.budget).toMatchObject({ spent: 30, reserved: 0, status: "active" });

    // Headroom is now 70; a call priced at 80 is refused before dispatch.
    const pricier = new Gateway(store.budgets, new MapCredentialStore({}));
    let dispatched = false;
    pricier.registerTool(tool({ id: "ext.pricey", estimate: 80 }), async () => {
      dispatched = true;
      return { ok: true, result: "too expensive" };
    });
    await expect(
      pricier.invoke({ budgetId: budget.id, tool: "ext.pricey" }),
    ).rejects.toBeInstanceOf(InsufficientBudgetError);
    expect(dispatched).toBe(false);
    const row = await store.budgets.get(budget.id);
    expect(row).toMatchObject({ spent: 30, reserved: 0, status: "active" });
  });

  it("commits measured usage after dispatch and flips exhausted on overrun", async () => {
    const budget = await store.budgets.create({
      name: "goal:overrun",
      limitAmount: 10,
      dim: "usd",
    });
    const gw = new Gateway(store.budgets, new MapCredentialStore({}));
    gw.registerTool(tool({ estimate: 4 }), async () => ({
      ok: true,
      result: "done",
      actual: 25,
    }));

    const out = await gw.invoke({ budgetId: budget.id, tool: "ext.echo" });
    expect(out.budget).toMatchObject({
      spent: 25,
      reserved: 0,
      status: "exhausted",
    });
    const usage = await db.query(
      "SELECT amount, basis FROM usage_records WHERE budget_id = $1",
      [budget.id],
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ basis: "measured" });
    expect(Number(usage.rows[0]?.amount)).toBe(25);

    // Once exhausted, no further call can be pre-authorized.
    await expect(
      gw.invoke({ budgetId: budget.id, tool: "ext.echo" }),
    ).rejects.toBeInstanceOf(InsufficientBudgetError);
  });

  it("never returns the account credential to the caller", async () => {
    const budget = await store.budgets.create({
      name: "goal:secret",
      limitAmount: 100,
      dim: "usd",
    });
    const secret = "ghp_example_secret_value";
    const gw = new Gateway(
      store.budgets,
      new MapCredentialStore({ "ext:github/acct-7": secret }),
    );
    let seen: string | undefined;
    gw.registerTool(tool({ account: "ext:github/acct-7" }), async (_c, ctx) => {
      seen = ctx.credential;
      return { ok: true, result: { user: "octo" } };
    });

    const out = await gw.invoke({ budgetId: budget.id, tool: "ext.echo" });
    expect(seen).toBe(secret); // the provider, not the caller, receives it
    expect(JSON.stringify(out)).not.toContain(secret);
    expect("credential" in out).toBe(false);
  });

  it("refuses an MCP tool without declared risk or idempotency", async () => {
    const gw = new Gateway(store.budgets, new MapCredentialStore({}));
    const handler = async () => ({ ok: true, result: null });
    // An MCP server's declared tool list carries neither field.
    const mcpShaped = {
      version: "1",
      kind: "gateway",
      estimate: 1,
    } as unknown as ToolDefinition;
    expect(() =>
      gw.registerTool({ ...mcpShaped, id: "mcp.no-risk" }, handler),
    ).toThrow(ValidationError);
    expect(() =>
      gw.registerTool(
        {
          ...mcpShaped,
          id: "mcp.no-risk",
          risk: "R0_read",
        },
        handler,
      ),
    ).toThrow(ValidationError);
    // A caller cannot fall back to defaults at invoke time either.
    await expect(
      gw.invoke({ budgetId: 9999, tool: "mcp.no-risk" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

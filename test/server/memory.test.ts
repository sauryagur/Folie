import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import type { Store } from "../../src/server/store";
import { testStore } from "../support/db";
import { artifactRef, canRead, sha256Of } from "../../src/server/memory";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
beforeAll(async () => ({ db, store, reset } = await testStore()));
beforeEach(async () => {
  await reset();
  await db.query(
    "TRUNCATE memories, memory_links, artifacts RESTART IDENTITY CASCADE",
  );
});
afterAll(() => db.close());

describe("scoped ACL", () => {
  it("enforces agent/team/goal/swarm and operator", async () => {
    const aOwn = await store.memories.write({
      scope: "agent",
      scopeId: "a",
      kind: "semantic",
      content: "a lesson",
      createdBy: "a",
    });
    const bOwn = await store.memories.write({
      scope: "agent",
      scopeId: "b",
      kind: "semantic",
      content: "b lesson",
      createdBy: "b",
    });
    const goalEntry = await store.memories.write({
      scope: "goal",
      scopeId: "g1",
      kind: "claim",
      content: "goal fact",
      createdBy: "a",
    });
    const teamEntry = await store.memories.write({
      scope: "team",
      scopeId: "t1",
      kind: "semantic",
      content: "team note",
      createdBy: "a",
    });
    const swarmEntry = await store.memories.write({
      scope: "swarm",
      scopeId: "sw",
      kind: "semantic",
      content: "swarm fact",
      createdBy: "a",
    });

    // Owner sees own agent entry only.
    expect(
      (await store.memories.query({}, { name: "a" })).map((e) => e.id),
    ).toEqual([aOwn]);
    // Goal participant sees goal entry; non-participant does not.
    expect(
      (await store.memories.query({}, { name: "a", goals: ["g1"] })).map((e) => e.id),
    ).toEqual(expect.arrayContaining([aOwn, goalEntry]));
    expect(
      (await store.memories.query({}, { name: "c", goals: ["g2"] })).map((e) => e.id),
    ).toEqual([]);
    // Team member sees team entry; outsider does not.
    expect(
      (await store.memories.query({}, { name: "c", teams: ["t1"] })).map((e) => e.id),
    ).toEqual([teamEntry]);
    expect(
      (await store.memories.query({}, { name: "c", teams: ["t2"] })).map((e) => e.id),
    ).toEqual([]);
    // Swarm needs the grant.
    expect(
      (await store.memories.query({}, { name: "c" })).map((e) => e.id),
    ).toEqual([]);
    expect(
      (await store.memories.query({}, { name: "c", swarm: true })).map((e) => e.id),
    ).toEqual([swarmEntry]);
    // Operator sees all.
    expect((await store.memories.query({}, { name: "op", kind: "operator" })).map((e) => e.id)).toEqual(
      expect.arrayContaining([aOwn, bOwn, goalEntry, teamEntry, swarmEntry]),
    );
    // Scoped filter cannot widen past the ACL.
    expect(
      (
        await store.memories.query(
          { scope: "agent", scopeId: "b" },
          { name: "a" },
        )
      ).map((e) => e.id),
    ).toEqual([]);
  });

  it("canRead mirrors the SQL predicate", async () => {
    const e = await store.memories.write({
      scope: "goal",
      scopeId: "g1",
      kind: "claim",
      content: "x",
      createdBy: "a",
    });
    const [entry] = await store.memories.query(
      {},
      { name: "a", goals: ["g1"] },
    );
    expect(entry!.id).toBe(e);
    expect(canRead(entry!, { name: "a", goals: ["g1"] })).toBe(true);
    expect(canRead(entry!, { name: "a" })).toBe(false);
  });
});

describe("contradictions", () => {
  it("links and marks both contested, never silently resolves", async () => {
    const a = await store.memories.write({
      scope: "goal",
      scopeId: "g1",
      kind: "claim",
      content: "cache is 5s",
      createdBy: "a",
      provenance: { source: "session:1" },
    });
    const b = await store.memories.write({
      scope: "goal",
      scopeId: "g1",
      kind: "claim",
      content: "cache is 60s",
      createdBy: "b",
      provenance: { source: "session:2" },
      contradicts: [a],
    });
    const rows = await store.memories.query(
      { scope: "goal", scopeId: "g1" },
      { name: "a", goals: ["g1"] },
    );
    expect(rows.map((r) => r.status).sort()).toEqual([
      "contested",
      "contested",
    ]);
    const bRow = rows.find((r) => r.id === b)!;
    expect(bRow.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a, kind: "contradicts" }),
      ]),
    );
    // Resolution is a new supersedes entry; the contested pair stays.
    const r = await store.memories.write({
      scope: "goal",
      scopeId: "g1",
      kind: "claim",
      content: "cache is 30s (measured)",
      createdBy: "a",
      provenance: { source: "session:3" },
      supersedes: a,
    });
    const after = await store.memories.query(
      { scope: "goal", scopeId: "g1" },
      { name: "a", goals: ["g1"] },
    );
    expect(after.map((e) => e.id)).toEqual(
      expect.arrayContaining([a, b, r]),
    );
    expect(after.find((e) => e.id === a)!.status).toBe("superseded");
    expect(after.find((e) => e.id === a)!.supersededBy).toBe(r);
    expect(after.find((e) => e.id === b)!.status).toBe("contested");
  });
});

describe("portable cross-goal", () => {
  it("returns only portable agent entries", async () => {
    await store.memories.write({
      scope: "agent",
      scopeId: "a",
      kind: "semantic",
      content: "portable trick",
      createdBy: "a",
      portable: true,
      originGoalId: "g1",
    });
    await store.memories.write({
      scope: "agent",
      scopeId: "a",
      kind: "semantic",
      content: "private quirk",
      createdBy: "a",
      portable: false,
      originGoalId: "g1",
    });
    await store.memories.write({
      scope: "goal",
      scopeId: "g1",
      kind: "claim",
      content: "goal g1 fact",
      createdBy: "a",
    });
    // Cross-goal (from g2's context): only the portable agent entry crosses.
    const crossed = await store.memories.query(
      { portableOnly: true },
      { name: "a", goals: ["g2"] },
    );
    expect(crossed.map((e) => e.content)).toEqual(["portable trick"]);
    expect(crossed[0]!.scope).toBe("agent");
    // Another agent cannot read my portable entries.
    expect(
      await store.memories.query({ portableOnly: true }, { name: "b" }),
    ).toEqual([]);
  });
});

describe("artifacts", () => {
  it("are content-addressed and survive retire + agent deletion", async () => {
    await store.agents.touch("a");
    const bytes = Buffer.from("report bytes", "utf8");
    const put = await store.artifacts.put({
      bytes,
      name: "report.txt",
      mediaType: "text/plain",
      producer: "a",
    });
    expect(put.sha256).toBe(sha256Of(bytes));
    expect(put.ref).toBe(artifactRef(put.sha256));
    expect(put.bytes).toBe(bytes.length);
    // Same bytes, same ref (idempotent put).
    expect(
      await store.artifacts.put({ bytes, producer: "a" }),
    ).toMatchObject({ sha256: put.sha256, ref: put.ref });

    // Retire-then-fetch: termination + retirement + even agent row deletion.
    store.registry.record({
      id: "exec-1",
      agent: "a",
      generation: 1,
      state: "running",
    });
    await db.query(
      "INSERT INTO executions (id, agent_name, state, generation) VALUES ('exec-1','a','running',1) ON CONFLICT DO NOTHING",
    );
    await store.agents.setState("a", "retired");
    await db.query(
      "UPDATE executions SET state='terminated' WHERE id='exec-1'",
    );
    await db.query("DELETE FROM executions WHERE id='exec-1'");
    await db.query("DELETE FROM agents WHERE name='a'");
    const got = await store.artifacts.get(put.ref);
    expect(got).not.toBeNull();
    expect(Buffer.from(got!.data).toString("utf8")).toBe("report bytes");
    expect(got!.producer).toBe("a");
    expect(got!.name).toBe("report.txt");
    // Also fetchable by bare hash.
    expect((await store.artifacts.get(put.sha256))!.sha256).toBe(put.sha256);
  });
});

describe("memory_write default scope", () => {
  it("defaults to goal scope", async () => {
    const id = await store.memories.write({
      scopeId: "g1",
      content: "default scoped",
      createdBy: "a",
    });
    const [row] = await store.memories.query(
      {},
      { name: "a", goals: ["g1"] },
    );
    expect(row!.id).toBe(id);
    expect(row!.scope).toBe("goal");
  });
});

// Capabilities: declared -> assessed -> verified with independence-enforced evidence; low-risk only at declared.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import type { Store } from "../../src/server/store";
import { testStore } from "../support/db";
import {
  assessCapability,
  declareCapability,
  defineCapability,
  isEligible,
  levelFor,
  verifyCapability,
} from "../../src/server/capabilities";

let db: Database;
let store: Store;
let reset: () => Promise<void>;

beforeAll(async () => ({ db, store, reset } = await testStore()));
beforeEach(async () => {
  await reset();
  await db.query(
    "TRUNCATE teams, team_members, capabilities, agent_capabilities, coordination_proposals, negotiation_dissents RESTART IDENTITY CASCADE",
  );
});
afterAll(() => db.close());

describe("capability levels", () => {
  it("walks declared -> assessed -> verified with probe + verifier", async () => {
    await store.agents.register("alice");
    await store.agents.register("verifier");
    await defineCapability(store, { name: "code", riskClass: "R0" });
    const d = await declareCapability(store, "alice", "code");
    expect(d.level).toBe("declared");
    const a = await assessCapability(
      store,
      "alice",
      "code",
      { score: 9 },
      "verifier",
    );
    expect(a.level).toBe("assessed");
    const v = await verifyCapability(
      store,
      "alice",
      "code",
      { passes: 5 },
      "verifier",
    );
    expect(v.level).toBe("verified");
    expect(await levelFor(store, "alice", "code")).toBe("verified");
  });

  it("requires verifier identity and independence", async () => {
    await store.agents.register("alice");
    await defineCapability(store, { name: "code" });
    await declareCapability(store, "alice", "code");
    await expect(
      assessCapability(store, "alice", "code", {}, "alice"),
    ).rejects.toThrow(/independence/);
    await expect(
      verifyCapability(store, "alice", "code", {}, "alice"),
    ).rejects.toThrow(/independence/);
  });

  it("requires forward-only evidence (declared before assessed before verified)", async () => {
    await store.agents.register("alice");
    await store.agents.register("verifier");
    await defineCapability(store, { name: "code" });
    await expect(
      assessCapability(store, "alice", "code", {}, "verifier"),
    ).rejects.toThrow(/invalid_transition/);
    await declareCapability(store, "alice", "code");
    await expect(
      verifyCapability(store, "alice", "code", {}, "verifier"),
    ).rejects.toThrow(/invalid_transition/);
  });
});

describe("eligibility gating", () => {
  it("admits self-declared only for low-risk work (R0-R1), conservative default", () => {
    // Low-risk: declared is enough.
    expect(isEligible("declared", "declared", "R0")).toBe(true);
    expect(isEligible("declared", "declared", "R1")).toBe(true);
    // High-risk: declared never admits, even when the task only asks for declared.
    expect(isEligible("declared", "declared", "R3")).toBe(false);
    expect(isEligible("declared", "declared", "R4")).toBe(false);
    expect(isEligible("declared", "declared", "R6")).toBe(false);
    // Assessed admits mid-risk; verified admits up to R6.
    expect(isEligible("assessed", "assessed", "R3")).toBe(true);
    expect(isEligible("verified", "verified", "R6")).toBe(true);
    // R7 never via level alone (needs independent safety attestation).
    expect(isEligible("verified", "verified", "R7")).toBe(false);
    // Missing evidence admits nothing.
    expect(isEligible(null, "declared", "R0")).toBe(false);
    // Falling short of the required level denies.
    expect(isEligible("assessed", "verified", "R0")).toBe(false);
  });
});

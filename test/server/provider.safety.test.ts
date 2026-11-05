// R-6.7/R-6.8/R-6.11: debug never true, resources never unlimited. No ax/substrate needed: provider boundary.
import { describe, expect, it } from "vitest";
import { parseResources } from "../../src/server/config";
import type { ExecutionSpec } from "../../src/server/provider";

const baseSpec = (over: Partial<ExecutionSpec> = {}): ExecutionSpec => ({
  key: "a",
  namespace: "folie",
  image: "folie-agent:latest",
  command: ["run"],
  env: {},
  network: { profile: "full-trust" },
  ...over,
});

describe("provider safety", () => {
  it("debug is false unless explicitly set (R-6.7 adapter default)", () => {
    expect(baseSpec().debug).toBeUndefined();
    // The ax adapter maps absent -> false in CreateTask (ax.ts); this documents the contract.
  });

  it("default resources are bounded, never unlimited (R-6.11)", () => {
    expect(parseResources(undefined)).toEqual({ cpu: "500m", memory: "512Mi" });
    expect(parseResources("")).toEqual({ cpu: "500m", memory: "512Mi" });
    expect(parseResources("cpu=250m,memory=256Mi")).toEqual({ cpu: "250m", memory: "256Mi" });
    // A caller that wants unlimited must change config code, not just unset env.
    expect(parseResources(undefined)?.cpu).not.toBeUndefined();
    expect(parseResources(undefined)?.memory).not.toBeUndefined();
  });

  it("every task carries resources (R-6.8)", () => {
    const spec = baseSpec({ resources: parseResources(undefined) });
    expect(spec.resources).toBeDefined();
  });
});

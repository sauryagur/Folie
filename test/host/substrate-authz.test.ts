import { describe, expect, it } from "vitest";
import { withBootstrapOwner } from "../../src/host/substrate-authz";

const FLAG = "--authz-bootstrap-owners=";
const owner = "system:serviceaccount:folie:folie-server";

describe("withBootstrapOwner", () => {
  it("appends the owner after the existing ones", () => {
    expect(withBootstrapOwner(`${FLAG}a,b`, owner)).toBe(`${FLAG}a,b,${owner}`);
  });

  it("returns null when already listed, so re-running `folie up` does not roll ate-api-server", () => {
    expect(withBootstrapOwner(`${FLAG}a,${owner}`, owner)).toBeNull();
  });

  it("handles an empty list", () => {
    expect(withBootstrapOwner(FLAG, owner)).toBe(FLAG + owner);
  });

  it("refuses an argument that is not the owners flag", () => {
    expect(() => withBootstrapOwner("--other=x", owner)).toThrow(/not an/);
  });
});

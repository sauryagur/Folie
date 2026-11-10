import { describe, expect, it } from "vitest";
import {
  SUBSTRATE_VERSION,
  axPinWarning,
  substrateVersionOf,
} from "../../src/host/ax-pin";

const goMod = (v: string) =>
  `module github.com/google/ax\n\ngo 1.27.1\n\nrequire (\n\tgithub.com/x/y v1.2.3\n\tgo.ate.dev/substrate ${v}\n)\n`;

describe("ax checkout Substrate pin", () => {
  it("reads the Substrate version an ax go.mod requires", () => {
    expect(substrateVersionOf(goMod("v1.0.0"))).toBe("v1.0.0");
    expect(substrateVersionOf(goMod("v1.0.0-rc.1"))).toBe("v1.0.0-rc.1");
    expect(substrateVersionOf("module x\n")).toBeNull();
  });

  it("is silent when ax installs the Substrate Folie's proto speaks", () => {
    expect(axPinWarning(goMod(SUBSTRATE_VERSION), "/ax")).toBeNull();
  });

  it("warns, naming both versions, when ax installs a different Substrate", () => {
    const w = axPinWarning(goMod("v0.6.0"), "/ax");
    expect(w).toContain("Substrate v0.6.0");
    expect(w).toContain(SUBSTRATE_VERSION);
  });

  it("warns when the ax checkout is missing its go.mod", () => {
    expect(axPinWarning(null, "/nowhere")).toMatch(/no go\.mod in \/nowhere/);
  });
});

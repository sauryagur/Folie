// R-6.1: provider concepts stay behind the ExecutionProvider port. The adapter (ax.ts) and the
// composition root (main.ts) may gib about ax/Substrate; nothing else in src/ may.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROVIDER_EXPORTS = /\bAxClient|AxTaskSpec|atespace|AxPhase|SuspendTask|CreateTask\b/;

describe("provider boundary", () => {
  it("only the ax adapter and the composition root know ax exists", () => {
    for (const f of readdirSync("src/server")) {
      if (!f.endsWith(".ts") || f === "ax.ts" || f === "main.ts" || f === "substrate.ts" || f === "grpc.ts") continue;
      const src = readFileSync(join("src/server", f), "utf8");
      expect(src, `${f} must not import the ax adapter`).not.toMatch(/from "\.\/ax"|from "\.\/substrate"/);
    }
  });

  it("src/server/controller.ts speaks only the provider port", () => {
    const src = readFileSync("src/server/controller.ts", "utf8");
    expect(src).not.toMatch(PROVIDER_EXPORTS);
  });

  it("src/server/provider.ts is self-contained (no adapter imports)", () => {
    const src = readFileSync("src/server/provider.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
  });
});

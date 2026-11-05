import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderManifest } from "../../src/host/manifest";

describe("renderManifest", () => {
  it("substitutes every occurrence", () => {
    expect(renderManifest("a: ${X}\nb: ${X}-${Y}", { X: "1", Y: "2" })).toBe(
      "a: 1\nb: 1-2",
    );
  });

  it("fails on a placeholder with no value rather than shipping it literally", () => {
    expect(() => renderManifest("image: ${FOLIE_SERVER_IMAGE}", {})).toThrow(
      /FOLIE_SERVER_IMAGE/,
    );
  });

  it("leaves kubernetes $(VAR) references alone", () => {
    expect(
      renderManifest("url: postgres://u:$(PGPASSWORD)@h/${DB}", {
        DB: "folie",
      }),
    ).toBe("url: postgres://u:$(PGPASSWORD)@h/folie");
  });

  it("renders the shipped server manifest given its two images", () => {
    const text = readFileSync(
      new URL("../../deploy/server.yaml", import.meta.url),
      "utf8",
    );
    const out = renderManifest(text, {
      FOLIE_SERVER_IMAGE: "r/s@sha256:1",
      FOLIE_AGENT_IMAGE: "r/a@sha256:2",
    });
    expect(out).toContain("image: r/s@sha256:1");
    expect(out).toContain("value: r/a@sha256:2");
    expect(out).not.toMatch(/\$\{/);
  });
});

// Config module rules: env overrides, `set` validation, display masking.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultConfig,
  displayConfigValue,
  getEffectiveConfig,
  saveConfig,
  setConfigValue,
  unknownConfigKeys,
  type FolieConfig,
} from "../../src/config";

describe("getEffectiveConfig agent environment", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "folie-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", dir);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores an empty FOLIE_AGENT_ENV_* value, so a blank .env line cannot erase the configured key", () => {
    saveConfig({
      ...createDefaultConfig(),
      model_api_key: "configured-key",
      agent_env: [{ key: "KEEP", value: "1" }],
    });
    vi.stubEnv("FOLIE_AGENT_ENV_OPENROUTER_API_KEY", "");
    vi.stubEnv("FOLIE_AGENT_ENV_EXTRA", "x");

    const c = getEffectiveConfig();
    expect(c.model_api_key).toBe("configured-key");
    expect(c.agent_env.find((e) => e.key === "OPENROUTER_API_KEY")).toBeUndefined();
    expect(c.agent_env).toContainEqual({ key: "KEEP", value: "1" });
    expect(c.agent_env).toContainEqual({ key: "EXTRA", value: "x" });
  });

  it("lets a non-empty FOLIE_AGENT_ENV_* value override the configured entry", () => {
    saveConfig({
      ...createDefaultConfig(),
      agent_env: [{ key: "KEEP", value: "1" }],
    });
    vi.stubEnv("FOLIE_AGENT_ENV_KEEP", "2");

    expect(getEffectiveConfig().agent_env).toContainEqual({ key: "KEEP", value: "2" });
  });
});

describe("setConfigValue", () => {
  const base = (): FolieConfig => ({ ...createDefaultConfig(), operator_token: "t" });

  it("does not block a change because of an error the config already had", () => {
    // An ax config missing both kubeconfig_context and agent_image can be completed one field at a time.
    const incomplete: FolieConfig = { ...base(), execution_profile: "ax", model_api_key: "k" };
    const r = setConfigValue(incomplete, "agent_image", "img:dev");
    expect(r).toEqual({ config: { ...incomplete, agent_image: "img:dev" } });
  });

  it("refuses a change that introduces a validation error", () => {
    expect(setConfigValue(base(), "server_port", "70000")).toEqual({
      error: "server_port must be 1-65535",
    });
    expect(setConfigValue(base(), "execution_profile", "cloud")).toMatchObject({
      error: expect.stringContaining("execution_profile must be"),
    });
  });

  it("refuses empty values and trims surrounding whitespace", () => {
    expect(setConfigValue(base(), "atespace", "   ")).toEqual({
      error: "atespace: value must not be empty",
    });
    expect(setConfigValue(base(), "atespace", "  team  ")).toEqual({
      config: { ...base(), atespace: "team" },
    });
  });
});

describe("config display", () => {
  it("masks secrets and agent_env values, and labels unset values", () => {
    expect(displayConfigValue("model_api_key", "sk-or-secret")).toBe("sk********et");
    expect(displayConfigValue("operator_token", "abcdefgh")).toBe("ab****gh");
    expect(displayConfigValue("agent_env", [{ key: "A", value: "secret" }])).toBe("A=se**et");
    expect(displayConfigValue("model_api_key", "")).toBe("(not set)");
    expect(displayConfigValue("agent_image", undefined)).toBe("(not set)");
    expect(displayConfigValue("default_model", "openrouter/x")).toBe("openrouter/x");
  });

  it("finds unknown fields but accepts the legacy namespace field", () => {
    expect(unknownConfigKeys({ ...createDefaultConfig(), set: "x", namespace: "n" })).toEqual(["set"]);
  });
});

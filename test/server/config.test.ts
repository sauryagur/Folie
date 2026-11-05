import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config";

const base = {
  DATABASE_URL: "postgres://x",
  FOLIE_AGENT_IMAGE: "img@sha256:1",
  FOLIE_OPERATOR_TOKEN: "operator-secret",
};

describe("loadConfig", () => {
  it("fills in-cluster defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 8080,
      axAddr: "ax-server.ax-system.svc:8080",
      reconcileMs: 2000,
      controller: {
        namespace: "folie",
        image: "img@sha256:1",
        command: ["/usr/local/bin/folie-agent"],
      },
      substrate: {
        address: "api.ate-system.svc.cluster.local:443",
        authority: "api.ate-system.svc",
        caFile: "/run/servicedns-ca/trust-bundle.pem",
        tokenFile: "/var/run/secrets/ateapi/token",
        ports: { http: [80, 8080], tls: [443] },
      },
    });
    expect(c.controller.env).toEqual({
      FOLIE_SERVER_URL: "http://folie-server.folie.svc:8080",
    });
  });

  it("forwards FOLIE_AGENT_ENV_* into agent env with the prefix stripped, and nothing else", () => {
    const c = loadConfig({
      ...base,
      FOLIE_AGENT_ENV_ANTHROPIC_API_KEY: "sk",
      FOLIE_AGENT_ENV_FOLIE_MODEL: "m",
      PATH: "/bin",
    });
    expect(c.controller.env).toMatchObject({
      ANTHROPIC_API_KEY: "sk",
      FOLIE_MODEL: "m",
    });
    expect(c.controller.env).not.toHaveProperty("PATH");
    expect(c.controller.env).not.toHaveProperty("DATABASE_URL");
  });

  it.each(["DATABASE_URL", "FOLIE_AGENT_IMAGE"])("requires %s", (key) => {
    const { [key]: _, ...rest } = base as Record<string, string>;
    expect(() => loadConfig(rest)).toThrow(key);
  });

  it("reads egress ports from the environment", () => {
    const c = loadConfig({
      ...base,
      FOLIE_EGRESS_HTTP_PORTS: "80, 3000",
      FOLIE_EGRESS_TLS_PORTS: "443,8443",
    });
    expect(c.substrate.ports).toEqual({ http: [80, 3000], tls: [443, 8443] });
  });

  it("exports telemetry only when a collector endpoint is configured; an empty value counts as unset", () => {
    expect(loadConfig(base).otlpEndpoint).toBeUndefined();
    expect(
      loadConfig({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: "" }).otlpEndpoint,
    ).toBeUndefined();
    expect(
      loadConfig({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" })
        .otlpEndpoint,
    ).toBe("http://otel:4318");
  });

  it("defaults to a modest pool that suspends after a minute and retires after an hour", () => {
    const c = loadConfig(base);
    expect(c.maxAgents).toBe(8);
    expect(c.controller).toMatchObject({
      suspendAfterSec: 60,
      deleteAfterSec: 3600,
    });
  });

  it("reads pool and lifecycle settings", () => {
    const c = loadConfig({
      ...base,
      FOLIE_MAX_AGENTS: "200",
      FOLIE_SUSPEND_AFTER_S: "10",
      FOLIE_DELETE_AFTER_S: "20",
    });
    expect(c.maxAgents).toBe(200);
    expect(c.controller).toMatchObject({
      suspendAfterSec: 10,
      deleteAfterSec: 20,
    });
  });

  it.each([
    "FOLIE_MAX_AGENTS",
    "FOLIE_SUSPEND_AFTER_S",
    "FOLIE_DELETE_AFTER_S",
  ])("rejects a non-positive or fractional %s", (key) => {
    for (const bad of ["0", "-1", "1.5", "soon"])
      expect(() => loadConfig({ ...base, [key]: bad })).toThrow(key);
  });

  it("requires retirement to come after suspension, or agents would be deleted before they were ever suspended", () => {
    expect(() =>
      loadConfig({
        ...base,
        FOLIE_SUSPEND_AFTER_S: "100",
        FOLIE_DELETE_AFTER_S: "100",
      }),
    ).toThrow(/exceed/);
  });

  it.each(["", "abc", "0", "70000", "80,,443", "80.5"])(
    "rejects egress ports %j",
    (raw) => {
      expect(() =>
        loadConfig({ ...base, FOLIE_EGRESS_HTTP_PORTS: raw }),
      ).toThrow(/FOLIE_EGRESS_HTTP_PORTS/);
    },
  );

  it("reads FOLIE_AGENT_RESOURCES into provider resource limits", () => {
    const c = loadConfig({
      ...base,
      FOLIE_AGENT_RESOURCES: "cpu=250m,memory=512Mi",
    });
    expect(c.controller.resources).toEqual({ cpu: "250m", memory: "512Mi" });
    expect(loadConfig(base).controller.resources).toEqual({
      cpu: "500m",
      memory: "512Mi",
    });
    for (const bad of ["nomatch", "cpu=1m,bad=2m"]) {
      expect(() => loadConfig({ ...base, FOLIE_AGENT_RESOURCES: bad })).toThrow(
        /FOLIE_AGENT_RESOURCES/,
      );
    }
  });

  const workspaceCheck = () => {
    const c = loadConfig(base);
    expect(c.controller.namespace).toBe("folie");
  };
  it("sets the execution namespace", workspaceCheck);
});

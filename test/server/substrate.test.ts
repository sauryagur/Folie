import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_PORTS, allowAllWebPolicy } from "../../src/server/substrate";

describe("allowAllWebPolicy", () => {
  const policy = allowAllWebPolicy("folie", DEFAULT_WEB_PORTS);

  it("is the atespace's singleton 'default' policy, as Substrate requires", () => {
    expect(policy.metadata).toEqual({ atespace: "folie", name: "default" });
  });

  it("allows every host on the cleartext and TLS web ports", () => {
    expect(policy.rules).toEqual([
      { http: { hostnames: ["*"], ports: { numbers: [80, 8080] } } },
      { tlsPassthrough: { hostnames: ["*"], ports: { numbers: [443] } } },
    ]);
  });

  it("never lets the HTTP and TLS rules share a port (Substrate rejects ties at admission)", () => {
    for (const ports of [DEFAULT_WEB_PORTS, { http: [80], tls: [443, 8443] }]) {
      const [http, tls] = allowAllWebPolicy("a", ports).rules;
      const httpPorts = http!.http!.ports.numbers;
      const tlsPorts = tls!.tlsPassthrough!.ports.numbers;
      expect(httpPorts.filter((p) => tlsPorts.includes(p))).toEqual([]);
    }
  });
});

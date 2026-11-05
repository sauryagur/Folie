// Egress policy port and its Substrate adapter.
// Substrate sandboxes deny all egress until their actor has an EgressPolicy, and ax sets none, so Folie
// grants one before an agent first runs. Full trust is the design: every host, on the web ports.
import * as grpc from "@grpc/grpc-js";
import { readFileSync } from "node:fs";
import { callUnary, isGrpcStatus, loadService } from "./grpc";
import { type EgressPolicyOptions, type WebPorts } from "./config";
import { DEFAULT_WEB_PORTS } from "./config";
export { DEFAULT_WEB_PORTS };

// The transport-free shapes (ports, defaults, options) live in config.ts with the deployment knobs; the
// adapter owns everything Substrate-specific.

export interface EgressPolicies {
  /** Idempotent: succeeds if the actor already has its policy. */
  ensureAllowAll(atespace: string, actor: string): Promise<void>;
}

/**
 * The same hostname pattern on overlapping ports would tie and be rejected at admission, so
 * the HTTP and TLS rules use disjoint ports. Other TCP is blocked by Substrate regardless.
 */
export function allowAllWebPolicy(atespace: string, ports: WebPorts) {
  return {
    metadata: { atespace, name: "default" },
    rules: [
      { http: { hostnames: ["*"], ports: { numbers: ports.http } } },
      { tlsPassthrough: { hostnames: ["*"], ports: { numbers: ports.tls } } },
    ],
  };
}

export function grpcEgressPolicies(opts: EgressPolicyOptions): EgressPolicies {
  const Control = loadService("ateapi.proto", ["ateapi", "Control"]);
  const callCreds = grpc.credentials.createFromMetadataGenerator((_params, cb) => {
    try {
      const md = new grpc.Metadata();
      md.set("authorization", `Bearer ${readFileSync(opts.tokenFile, "utf8").trim()}`);
      cb(null, md);
    } catch (e) {
      cb(e as Error);
    }
  });
  const creds = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(readFileSync(opts.caFile)), callCreds);
  const c = new Control(opts.address, creds, {
    "grpc.ssl_target_name_override": opts.authority,
    "grpc.default_authority": opts.authority,
  });

  return {
    async ensureAllowAll(atespace, actor) {
      try {
        await callUnary(c, "CreateActorEgressPolicy", {
          actor: { atespace, name: actor },
          egressPolicy: allowAllWebPolicy(atespace, opts.ports),
        });
      } catch (e) {
        if (!isGrpcStatus(e, grpc.status.ALREADY_EXISTS)) throw e;
      }
    },
  };
}

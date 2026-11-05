// Environment -> typed config. Pure, so it is testable without a process.
import type { ControllerConfig } from "./controller";

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  axAddr: string;
  reconcileMs: number;
  /** Ceiling on live pool agents (`agent-<n>`); unaddressed goals queue beyond it. */
  maxAgents: number;
  controller: ControllerConfig;
  /** Options to build Substrate egress policy adapter; transport details live in substrate.ts. */
  substrate: EgressPolicyOptions;
  /** Collector base URL (OTLP/HTTP). Unset: spans still propagate, nothing is exported. */
  otlpEndpoint?: string;
  /** Operator bearer token (FOLIE_OPERATOR_TOKEN). Required for deployment; compared constant-time, stored hashed. */
  operatorToken: string;
}

export interface EgressPolicyOptions {
  address: string;
  /** TLS server name; Substrate's certificate is for api.ate-system.svc. */
  authority: string;
  caFile: string;
  /** Projected service-account token (audience api.ate-system.svc); re-read per call because it rotates. */
  tokenFile: string;
  ports: WebPorts;
}

export interface WebPorts {
  /** Cleartext HTTP (folie-server, package mirrors, ...). */
  http: number[];
  /** TLS forwarded without interception (LLM APIs, git over https, ...). */
  tls: number[];
}

export const DEFAULT_WEB_PORTS = { http: [80, 8080], tls: [443] };

/** Vars named FOLIE_AGENT_ENV_<NAME> are forwarded into every agent task as <NAME> (e.g. the LLM key). */
const FORWARD_PREFIX = "FOLIE_AGENT_ENV_";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
}

function ports(env: NodeJS.ProcessEnv, key: string, fallback: number[]): number[] {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const list = raw.split(",").map((s) => Number(s.trim()));
  if (list.length === 0 || !list.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
    throw new Error(`${key} must be a comma-separated list of ports, got ${JSON.stringify(raw)}`);
  }
  return list;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/** FOLIE_AGENT_RESOURCES="<k=v>,..." → `{ cpu: "250m", memory: "512Mi" }` at the provider. */
function parseResources(raw?: string): { cpu?: string; memory?: string } | undefined {
  if (!raw) return undefined;
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf("=");
    if (i <= 0 || !["cpu", "memory"].includes(s.slice(0, i))) throw new Error(`FOLIE_AGENT_RESOURCES entry must be cpu= or memory=, got ${JSON.stringify(s)}`);
    return [s.slice(0, i), s.slice(i + 1)] as [string, string];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const forwarded = Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => k.startsWith(FORWARD_PREFIX) && v !== undefined)
      .map(([k, v]) => [k.slice(FORWARD_PREFIX.length), v as string]),
  );
  const suspendAfterSec = positiveInt(env, "FOLIE_SUSPEND_AFTER_S", 60);
  const deleteAfterSec = positiveInt(env, "FOLIE_DELETE_AFTER_S", 3600);
  if (deleteAfterSec <= suspendAfterSec) throw new Error("FOLIE_DELETE_AFTER_S must exceed FOLIE_SUSPEND_AFTER_S");
  const operatorToken = required(env, "FOLIE_OPERATOR_TOKEN");
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: required(env, "DATABASE_URL"),
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    axAddr: env.AX_ADDR ?? "ax-server.ax-system.svc:8080",
    reconcileMs: Number(env.FOLIE_RECONCILE_MS ?? 2000),
    maxAgents: positiveInt(env, "FOLIE_MAX_AGENTS", 8),
    operatorToken,
    controller: {
      namespace: env.FOLIE_ATESPACE ?? "folie",
      image: required(env, "FOLIE_AGENT_IMAGE"),
      command: JSON.parse(env.FOLIE_AGENT_COMMAND ?? '["/usr/local/bin/folie-agent"]'),
      resources: parseResources(env.FOLIE_AGENT_RESOURCES),
      env: {
        FOLIE_SERVER_URL: env.FOLIE_AGENT_SERVER_URL ?? "http://folie-server.folie.svc:8080",
        ...forwarded,
      },
      suspendAfterSec,
      deleteAfterSec,
    },
    substrate: {
      address: env.SUBSTRATE_ADDR ?? "api.ate-system.svc.cluster.local:443",
      authority: env.SUBSTRATE_AUTHORITY ?? "api.ate-system.svc",
      caFile: env.SUBSTRATE_CA_FILE ?? "/run/servicedns-ca/trust-bundle.pem",
      tokenFile: env.SUBSTRATE_TOKEN_FILE ?? "/var/run/secrets/ateapi/token",
      ports: {
        http: ports(env, "FOLIE_EGRESS_HTTP_PORTS", DEFAULT_WEB_PORTS.http),
        tls: ports(env, "FOLIE_EGRESS_TLS_PORTS", DEFAULT_WEB_PORTS.tls),
      },
    },
  };
}

// Configuration system for Folie.
// Replaces environment variables with a YAML config file at ~/.config/folie/config.yaml
// Env vars still override config for CI/CD compatibility.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const CONFIG_VERSION = 2;
export const CONFIG_DIR_NAME = "folie";
export const CONFIG_FILE_NAME = "config.yaml";
export type ExecutionProfile = "local" | "ax";

export interface AgentEnvEntry {
  key: string;
  value: string;
}

export interface FolieConfig {
  config_version: number;
  execution_profile: ExecutionProfile;
  kubeconfig_context?: string;
  operator_token: string;
  agent_image?: string;
  default_model: string;
  model_api_key: string;
  atespace: string;
  agent_runtime: "strands" | "pi" | "echo";
  agent_env: AgentEnvEntry[];
  server_port: number;
  reconcile_ms: number;
}

export const DEFAULT_CONFIG: Omit<FolieConfig, "config_version" | "operator_token" | "model_api_key"> = {
  execution_profile: "local",
  default_model: "openrouter/deepseek/deepseek-chat",
  atespace: "folie",
  agent_runtime: "strands",
  agent_env: [],
  server_port: 8080,
  reconcile_ms: 2000,
};

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ?? join(homedir(), ".config");
  return join(base, CONFIG_DIR_NAME);
}

export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME);
}

function generateOperatorToken(): string {
  return randomBytes(32).toString("base64url");
}

function maskSecret(value: string): string {
  if (!value) return "";
  return value.length > 4 ? `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}` : '****';
}

export function loadConfig(): FolieConfig | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, "utf8");
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object') return null;
    // Validate required fields exist
    const required = ['config_version', 'operator_token', 'default_model', 'model_api_key', 'atespace', 'agent_runtime', 'agent_env', 'server_port', 'reconcile_ms'];
    for (const field of required) {
      if (!(field in parsed)) return null;
    }
    const version = Number(parsed.config_version);
    if (version !== 1 && version !== CONFIG_VERSION) return null;
    const profile = parsed.execution_profile;
    const execution_profile: ExecutionProfile =
      profile === "local" || profile === "ax"
        ? profile
        // Preserve the old cluster-backed behavior for existing v1 installations.
        : version === 1
          ? "ax"
          : "local";
    return {
      ...parsed,
      config_version: CONFIG_VERSION,
      execution_profile,
    } as unknown as FolieConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: FolieConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const path = getConfigPath();
  const yaml = stringifyYaml(config as unknown as Record<string, unknown>);
  writeFileSync(path, yaml, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function ensureConfig(): FolieConfig {
  let config = loadConfig();
  if (!config) {
    config = createDefaultConfig();
    saveConfig(config);
  }
  return config;
}

export function createDefaultConfig(): FolieConfig {
  return {
    config_version: CONFIG_VERSION,
    execution_profile: DEFAULT_CONFIG.execution_profile,
    operator_token: generateOperatorToken(),
    default_model: DEFAULT_CONFIG.default_model,
    model_api_key: "",
    atespace: DEFAULT_CONFIG.atespace,
    agent_runtime: DEFAULT_CONFIG.agent_runtime,
    agent_env: DEFAULT_CONFIG.agent_env,
    server_port: DEFAULT_CONFIG.server_port,
    reconcile_ms: DEFAULT_CONFIG.reconcile_ms,
  };
}

export function getEffectiveConfig(): FolieConfig {
  const config = ensureConfig();

  // Env vars override config (for CI/CD)
  const env = process.env;
  const result = { ...config };

  if (env.FOLIE_EXECUTION_PROFILE)
    result.execution_profile = env.FOLIE_EXECUTION_PROFILE as ExecutionProfile;
  if (env.FOLIE_KUBECONFIG_CONTEXT) result.kubeconfig_context = env.FOLIE_KUBECONFIG_CONTEXT;
  if (env.FOLIE_OPERATOR_TOKEN) result.operator_token = env.FOLIE_OPERATOR_TOKEN;
  if (env.FOLIE_AGENT_IMAGE) result.agent_image = env.FOLIE_AGENT_IMAGE;
  if (env.FOLIE_MODEL) result.default_model = env.FOLIE_MODEL;
  if (env.FOLIE_AGENT_ENV_OPENROUTER_API_KEY) result.model_api_key = env.FOLIE_AGENT_ENV_OPENROUTER_API_KEY;
  if (env.FOLIE_ATESPACE) result.atespace = env.FOLIE_ATESPACE;
  if (env.FOLIE_RUNTIME) result.agent_runtime = env.FOLIE_RUNTIME as FolieConfig["agent_runtime"];
  if (env.FOLIE_SERVER_PORT) result.server_port = parseInt(env.FOLIE_SERVER_PORT, 10);
  if (env.FOLIE_RECONCILE_MS) result.reconcile_ms = parseInt(env.FOLIE_RECONCILE_MS, 10);

  // Environment overrides configured entries with the same key and preserves the rest.
  const agentEnv = new Map(result.agent_env.map((entry) => [entry.key, entry.value]));
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("FOLIE_AGENT_ENV_") || value === undefined) continue;
    agentEnv.set(name.slice("FOLIE_AGENT_ENV_".length), value);
  }
  result.agent_env = [...agentEnv].map(([key, value]) => ({ key, value }));

  return result;
}

export function getConfigForDisplay(config: FolieConfig): Record<string, string> {
  return {
    "config_version": String(config.config_version),
    "execution_profile": config.execution_profile,
    "execution_profile_note": config.execution_profile === "local"
      ? "trusted OS process; host filesystem/network access; no CPU/memory limits or sandbox; server crash may orphan workers"
      : "AX/Kubernetes execution; verify isolation and resource guarantees for the selected deployment",
    "kubeconfig_context": config.kubeconfig_context ?? "(not set)",
    "operator_token": maskSecret(config.operator_token),
    "agent_image": config.agent_image ?? "(not set)",
    "default_model": config.default_model,
    "model_api_key": maskSecret(config.model_api_key),
    "atespace": config.atespace,
    "agent_runtime": config.agent_runtime,
    "agent_env": config.agent_env.length > 0
      ? config.agent_env.map(e => `${e.key}=${maskSecret(e.value)}`).join(", ")
      : "(empty)",
    "server_port": String(config.server_port),
    "reconcile_ms": String(config.reconcile_ms),
  };
}

export function validateConfig(config: FolieConfig): string[] {
  const errors: string[] = [];

  if (!["local", "ax"].includes(config.execution_profile))
    errors.push("execution_profile must be 'local' or 'ax'");
  if (config.execution_profile === "ax" && !config.kubeconfig_context)
    errors.push("kubeconfig_context is required for the ax profile");
  if (!config.operator_token) errors.push("operator_token is required");
  if (config.execution_profile === "ax" && !config.agent_image)
    errors.push("agent_image is required for the ax profile");
  if (!config.default_model) errors.push("default_model is required");
  if (!config.model_api_key) errors.push("model_api_key is required");
  if (!config.atespace) errors.push("atespace is required");
  if (!("strands pi echo".split(" ") as string[]).includes(config.agent_runtime)) errors.push("agent_runtime must be 'strands', 'pi', or 'echo'");
  if (config.server_port < 1 || config.server_port > 65535) errors.push("server_port must be 1-65535");
  if (config.reconcile_ms < 100) errors.push("reconcile_ms must be >= 100");

  return errors;
}

// Simple YAML parser/stringifier for our flat config structure
// Avoids external dependency; handles our known structure only.

function parseYaml(content: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Remove inline comments
    const commentIndex = value.indexOf(' #');
    if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();

    // Handle flat arrays and the `KEY=value` agent environment entries.
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (!inner) {
        result[key] = [];
      } else {
        const items = splitArrayItems(inner).map(parseStringValue);
        result[key] = key === "agent_env"
          ? items.map((item) => {
              const separator = item.indexOf("=");
              if (separator <= 0) throw new Error("agent_env entries must be KEY=value");
              return { key: item.slice(0, separator), value: item.slice(separator + 1) };
            })
          : items;
      }
      continue;
    }

    // Handle quoted strings
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle booleans
    if (value === 'true') result[key] = true;
    else if (value === 'false') result[key] = false;
    // Handle numbers
    else if (/^-?\d+$/.test(value)) result[key] = parseInt(value, 10);
    else if (/^-?\d+\.\d+$/.test(value)) result[key] = parseFloat(value);
    else result[key] = value;
  }

  return result;
}

function stringifyYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (key === "agent_env") {
        const entries = value as AgentEnvEntry[];
        lines.push(`agent_env: [${entries.map((entry) => JSON.stringify(`${entry.key}=${entry.value}`)).join(", ")}]`);
      } else {
        lines.push(`${key}: [${value.map(v => stringifyValue(v)).join(", ")}]`);
      }
    } else {
      lines.push(`${key}: ${stringifyValue(value)}`);
    }
  }

  return lines.join('\n') + '\n';
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    if (/^[a-zA-Z0-9._/-]+$/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return String(value);
}

function splitArrayItems(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      items.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

function parseStringValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

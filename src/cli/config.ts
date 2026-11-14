// Config CLI commands
import { stdin as stdinRaw, stdout } from "node:process";
import * as readline from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { capture } from "../host/env";
import {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  getConfigPath,
  getEffectiveConfig,
  getConfigForDisplay,
  validateConfig,
  CONFIG_KEYS,
  displayConfigValue,
  setConfigValue,
  unknownConfigKeys,
} from "../config";
import type { FolieClient } from "../shared/client";

/** Warns about fields Folie does not know; an older `folie config set` stored values (secrets included) under a stray `set` field. */
function warnUnknownKeys(): void {
  const config = loadConfig();
  if (!config) return;
  for (const key of unknownConfigKeys(config))
    console.error(
      `warning: unknown field '${key}' in ${getConfigPath()}; it may hold a secret — remove it with \`folie config edit\``,
    );
}

async function prompt(r: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}] ` : `${question} `;
  const answer = await r.question(prompt);
  return answer.trim() || defaultValue || "";
}

async function promptSecret(r: readline.Interface, question: string): Promise<string> {
  return r.question(`${question} `);
}

async function selectFromList(r: readline.Interface, question: string, options: string[], getLabel?: (o: string) => string): Promise<string> {
  console.log(question);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${getLabel ? getLabel(o) : o}`));
  while (true) {
    const answer = await r.question("Select [1]: ");
    const idx = parseInt(answer.trim() || "1", 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx]!;
    console.log("Invalid selection");
  }
  // unreachable, but satisfies TS
  return options[0] ?? "";
}

export async function configCommand(
  subcmd: string,
  args: string[],
  _client: unknown
): Promise<number> {
  // Only the interactive wizard reads stdin; other subcommands must not hold it open.
  let prompter: readline.Interface | undefined;

  try {
    switch (subcmd) {
      case "init": {
        const configPath = getConfigPath();
        const defaults = args.includes("--defaults");
        const force = args.includes("--force");

        if (defaults) {
          if (existsSync(configPath) && !force) {
            console.log(
              `Config already exists at ${configPath} (use --force to overwrite)`,
            );
            return 0;
          }
          let config = createDefaultConfig();
          if (process.env.FOLIE_OPERATOR_TOKEN)
            config.operator_token = process.env.FOLIE_OPERATOR_TOKEN;
          if (process.env.FOLIE_SERVER_PORT)
            config.server_port = parseInt(process.env.FOLIE_SERVER_PORT, 10);
          if (process.env.FOLIE_EXECUTION_PROFILE === "local" || process.env.FOLIE_EXECUTION_PROFILE === "ax")
            config.execution_profile = process.env.FOLIE_EXECUTION_PROFILE;
          const errors = validateConfig(config);
          if (errors.length > 0) {
            console.error("Validation errors:", errors.join(", "));
            return 1;
          }
          saveConfig(config);
          console.log(`Config written to ${configPath}`);
          return 0;
        }

        const rl = (prompter = readline.createInterface({
          input: stdinRaw,
          output: stdout,
        }));
        if (existsSync(configPath)) {
          console.log(`Config already exists at ${configPath}`);
          const overwrite = await rl.question("Overwrite? [y/N]: ");
          if (overwrite.trim().toLowerCase() !== "y") {
            console.log("Aborted");
            return 0;
          }
        }

        console.log("Welcome to Folie! Let's set up your environment.\n");

        const execution_profile = await selectFromList(
          rl,
          "Execution profile (local runs trusted processes as your user; AX uses Kubernetes):",
          ["local", "ax"],
          (profile) => profile,
        ) as "local" | "ax";

        let kubeconfig_context: string | undefined;
        let agent_image: string | undefined;
        if (execution_profile === "ax") {
          const contexts = await listKubeContexts();
          kubeconfig_context = contexts.length > 0
            ? (await selectFromList(rl, "Kubernetes context:", contexts, c => c)) || "kind-folie"
            : "kind-folie";
          agent_image = await prompt(rl, "Agent image:", "localhost:5001/folie-agent:dev");
        }

        // Operator token
        const tokenChoice = await rl.question("Operator token: [generate] ");
        const operator_token = tokenChoice.trim() || randomBytes(32).toString("base64url");

        // Default model
        const default_model = await prompt(rl, "Default model:", "openrouter/deepseek/deepseek-chat");

        // Model API key
        const model_api_key = await promptSecret(rl, "Model API key:");

        // Atespace
        const atespace = await prompt(rl, "Default atespace:", "folie");

        // Agent runtime
        const runtime = await selectFromList(rl, "Agent runtime:", ["strands", "pi", "echo"], r => r) || "strands";

        // Server port
        const server_port = parseInt(await prompt(rl, "Server port:", "8080"), 10);

        // Reconcile interval
        const reconcile_ms = parseInt(await prompt(rl, "Reconcile interval (ms):", "2000"), 10);

        const config = {
          config_version: 2,
          execution_profile,
          kubeconfig_context,
          operator_token,
          agent_image,
          default_model,
          model_api_key,
          atespace,
          agent_runtime: runtime as "strands" | "pi" | "echo",
          agent_env: [],
          server_port,
          reconcile_ms,
        };

        const errors = validateConfig(config);
        if (errors.length > 0) {
          console.error("Validation errors:", errors.join(", "));
          return 1;
        }

        saveConfig(config);
        console.log(`\nConfig written to ${getConfigPath()}`);
        return 0;
      }

      case "view": {
        const config = getEffectiveConfig();
        const display = getConfigForDisplay(config);
        for (const [key, value] of Object.entries(display)) {
          console.log(`${key}: ${value}`);
        }
        warnUnknownKeys();
        return 0;
      }

      case "validate": {
        warnUnknownKeys();
        const config = getEffectiveConfig();
        const errors = validateConfig(config);
        if (errors.length === 0) {
          console.log("Config is valid");
          return 0;
        } else {
          console.error("Validation errors:");
          for (const e of errors) console.error(`  - ${e}`);
          return 1;
        }
      }

      case "edit": {
        const editor = process.env.EDITOR || "vi";
        const path = getConfigPath();
        const { spawn } = await import("node:child_process");
        await new Promise((resolve, reject) => {
          const child = spawn(editor, [path], { stdio: "inherit" });
          child.on("exit", (code: number) => code === 0 ? resolve(0) : reject(new Error(`Editor exited with ${code}`)));
        });
        return 0;
      }

      // `args` holds what follows the subcommand: `folie config get <key>` → ["<key>"].
      case "get": {
        const reveal = args.includes("--reveal");
        const key = args.find((a) => a !== "--reveal");
        if (!key) {
          console.error("Usage: folie config get <key> [--reveal]");
          return 1;
        }
        if (!CONFIG_KEYS.includes(key)) {
          console.error(`Unknown key: ${key}`);
          return 1;
        }
        const value = (getEffectiveConfig() as unknown as Record<string, unknown>)[key];
        if (!reveal) console.log(displayConfigValue(key, value));
        else if (key === "agent_env")
          console.log(
            (value as { key: string; value: string }[])
              .map((e) => `${e.key}=${e.value}`)
              .join("\n"),
          );
        else console.log(value === undefined ? "" : String(value));
        return 0;
      }

      // `folie config set <key> <value...>` → args = ["<key>", "<value>", ...].
      case "set": {
        const [key, ...rest] = args;
        const value = rest.join(" ");
        if (!key || !value) {
          console.error("Usage: folie config set <key> <value>");
          return 1;
        }
        const path = getConfigPath();
        const current = loadConfig();
        if (!current && existsSync(path)) {
          console.error(
            `Cannot read ${path}; fix it with \`folie config edit\` or recreate it with \`folie config init --force\`. Refusing to overwrite it with defaults.`,
          );
          return 1;
        }
        const result = setConfigValue(current ?? createDefaultConfig(), key, value);
        if ("error" in result) {
          console.error(`folie config set: ${result.error}`);
          return 1;
        }
        saveConfig(result.config);
        const saved = (result.config as unknown as Record<string, unknown>)[key];
        console.log(`Set ${key} = ${displayConfigValue(key, saved)}`);
        return 0;
      }

      default:
        console.error(`Unknown config command: ${subcmd}`);
        return 1;
    }
  } finally {
    prompter?.close();
  }
}

async function listKubeContexts(): Promise<string[]> {
  try {
    const output = await capture(["kubectl", "config", "get-contexts", "-o", "name"]);
    return output.split("\n").filter(Boolean);
  } catch {
    return ["kind-folie"];
  }
}

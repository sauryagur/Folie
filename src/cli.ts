#!/usr/bin/env bun
import {
  agents,
  artifactGet,
  cancel,
  config,
  pause,
  publish,
  resume,
  status,
  submit,
  subscribe,
  topics,
  unsubscribe,
  type Api,
} from "./cli/commands";
import { down as downAx, up as upAx } from "./host/cluster";
import { startLocalServer, stopLocalServer } from "./host/local";
import { CONTEXT, setKubeContext } from "./host/env";
import { withServerUrl } from "./host/portforward";
import { FolieClient } from "./shared/client";
import {
  createDefaultConfig,
  getEffectiveConfig,
  loadConfig,
  saveConfig,
  validateConfig,
  type ExecutionProfile,
} from "./config";

type Command = (args: string[]) => Promise<number | void>;

function operatorClient(url: string): FolieClient {
  const cfg = getEffectiveConfig();
  const token = process.env.FOLIE_OPERATOR_TOKEN ?? cfg.operator_token;
  if (!token)
    throw new Error(
      "FOLIE_OPERATOR_TOKEN is required for CLI/TUI. Set it to the operator credential (see `folie up`).",
    );
  return new FolieClient(url, fetch, token);
}

const viaServer =
  (
    cmd: (
      api: Api,
      args: string[],
      out: (l: string) => void,
    ) => Promise<number>,
  ): Command =>
  (args) =>
    withServerUrl((url) => cmd(operatorClient(url), args, console.log));

function requestedProfile(args: string[], command: "up" | "down"): ExecutionProfile | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--profile" || !["local", "ax"].includes(args[1]!))
    throw new Error(`usage: folie ${command} [--profile local|ax]`);
  return args[1] as ExecutionProfile;
}

const up: Command = async (args) => {
  const requested = requestedProfile(args, "up");
  const effective = getEffectiveConfig();
  const profile = requested ?? effective.execution_profile;
  const selected = {
    ...effective,
    execution_profile: profile,
    ...(profile === "ax"
      ? {
          kubeconfig_context: effective.kubeconfig_context ?? CONTEXT,
          agent_image: effective.agent_image ?? "localhost:5001/folie-agent:dev",
        }
      : {}),
  };
  const errors = validateConfig(selected);
  if (errors.length > 0) throw new Error(`invalid config: ${errors.join(", ")}`);

  // An explicit profile becomes the default for later `up`/`down` commands.
  if (requested) {
    const saved = loadConfig() ?? createDefaultConfig();
    saveConfig({
      ...saved,
      execution_profile: profile,
      ...(profile === "ax"
        ? {
            kubeconfig_context: selected.kubeconfig_context,
            agent_image: selected.agent_image,
          }
        : {}),
    });
  }

  if (profile === "ax") {
    setKubeContext(selected.kubeconfig_context ?? CONTEXT);
    await upAx();
  } else {
    await startLocalServer(selected);
  }
};

const down: Command = async (args) => {
  const profile = requestedProfile(args, "down") ?? getEffectiveConfig().execution_profile;
  if (profile === "ax") {
    const config = getEffectiveConfig();
    setKubeContext(config.kubeconfig_context ?? CONTEXT);
    await downAx();
  } else {
    await stopLocalServer();
  }
};

const commands: Record<string, Command> = {
  up,
  down,
  config: (args) => config(undefined as unknown as Api, args, console.log),
  submit: viaServer(submit),
  status: viaServer(status),
  artifact: (args) =>
    withServerUrl((url) => artifactGet(operatorClient(url), args, console.log)),
};

const [name, ...args] = process.argv.slice(2);

// `folie` with no arguments is the product: the interactive harness. The subcommands are the scripting surface.
const tui: Command = () =>
  withServerUrl(async (url) => {
    const { runTui } = await import("./tui/run"); // lazy: only the TUI needs the native renderer
    await runTui(operatorClient(url));
  });

const command = name === undefined ? tui : commands[name];
if (!command) {
  console.error(
    `usage: folie [${Object.keys(commands).join("|")}]   (up/down accept --profile local|ax; no arguments: open the TUI)`,
  );
  process.exit(2);
}
try {
  process.exit((await command(args)) ?? 0);
} catch (e) {
  console.error(`folie: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

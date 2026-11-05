#!/usr/bin/env bun
import { agents, publish, status, submit, subscribe, topics, unsubscribe, type Api } from "./cli/commands";
import { down, up } from "./host/cluster";
import { operatorTokenFromEnvOrFile, withServerUrl } from "./host/portforward";
import { FolieClient } from "./shared/client";

type Command = (args: string[]) => Promise<number | void>;

function operatorClient(url: string): FolieClient {
  const token = process.env.FOLIE_OPERATOR_TOKEN ?? operatorTokenFromEnvOrFile();
  if (!token) throw new Error("FOLIE_OPERATOR_TOKEN is required for CLI/TUI. Set it to the operator credential (see `folie up`).");
  return new FolieClient(url, fetch, token);
}

const viaServer =
  (cmd: (api: Api, args: string[], out: (l: string) => void) => Promise<number>): Command =>
  (args) => withServerUrl((url) => cmd(operatorClient(url), args, console.log));

const commands: Record<string, Command> = {
  up,
  down,
  submit: viaServer(submit),
  status: viaServer(status),
  agents: viaServer(agents),
  topics: viaServer(topics),
  subscribe: viaServer(subscribe),
  unsubscribe: viaServer(unsubscribe),
  publish: viaServer(publish),
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
  console.error(`usage: folie [${Object.keys(commands).join("|")}]   (no arguments: open the TUI)`);
  process.exit(2);
}
try {
  process.exit((await command(args)) ?? 0);
} catch (e) {
  console.error(`folie: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

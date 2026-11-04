#!/usr/bin/env bun
import { agents, publish, status, submit, subscribe, topics, unsubscribe, type Api } from "./cli/commands";
import { down, up } from "./host/cluster";
import { withServerUrl } from "./host/portforward";
import { FolieClient } from "./shared/client";

type Command = (args: string[]) => Promise<number | void>;

const viaServer =
  (cmd: (api: Api, args: string[], out: (l: string) => void) => Promise<number>): Command =>
  (args) => withServerUrl((url) => cmd(new FolieClient(url), args, console.log));

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

const [name = "", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error(`usage: folie <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
try {
  process.exit((await command(args)) ?? 0);
} catch (e) {
  console.error(`folie: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

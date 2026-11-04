// Host-side paths and process helpers shared by the bootstrap, image build and CLI.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOME = process.env.FOLIE_HOME ?? join(homedir(), ".folie");
export const BIN = join(HOME, "bin");
export const KUBECONFIG = join(HOME, "kubeconfig");
export const CLUSTER = "folie";
export const CONTEXT = `kind-${CLUSTER}`;
export const NS = "folie";
export const REGISTRY = "localhost:5001";
export const REPO = resolve(import.meta.dirname, "../..");
export const AX_DIR = resolve(process.env.FOLIE_AX_DIR ?? join(REPO, "../ax"));

export const env = () => ({
  ...process.env,
  PATH: `${BIN}:${process.env.PATH}`,
  KUBECONFIG,
  KIND_CLUSTER_NAME: CLUSTER,
});

export interface RunOpts {
  cwd?: string;
  stdin?: string;
  quiet?: boolean;
  env?: Record<string, string | undefined>;
}

export async function run(cmd: string[], opts: RunOpts = {}): Promise<boolean> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...env(), ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: opts.quiet ? "ignore" : "inherit",
    stderr: opts.quiet ? "ignore" : "inherit",
  });
  return (await p.exited) === 0;
}

export async function must(cmd: string[], opts?: RunOpts) {
  if (!(await run(cmd, opts))) throw new Error(`failed: ${cmd.join(" ")}`);
}

/** Runs a command and returns trimmed stdout; throws on non-zero exit. */
export async function capture(cmd: string[], opts: RunOpts = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...env(), ...opts.env }, stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
  return out.trim();
}

export const kubectl = (...args: string[]) => ["kubectl", "--context", CONTEXT, ...args];

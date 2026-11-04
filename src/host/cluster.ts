// `folie up` / `folie down`: the whole laptop world (kind + Substrate + ax + Postgres + folie-server).
// Substrate and ax are installed by ax's own hack/setup-e2e-kind.sh; Folie never patches ax.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AX_DIR, CLUSTER, CONTEXT, KUBECONFIG, NS, REPO, kubectl, must, run, BIN, capture } from "./env";
import { buildImages } from "./images";
import { renderManifest } from "./manifest";
import { grantFolieServerSubstrateAccess } from "./substrate-authz";
import { ALL_TOOLS, ensureTool } from "./tools";

/** Host env vars named FOLIE_AGENT_ENV_<NAME> become <NAME> inside every agent task (LLM key, FOLIE_RUNTIME, ...). */
const AGENT_ENV_PREFIX = "FOLIE_AGENT_ENV_";

async function clusterExists() {
  const out = await capture(["kind", "get", "clusters"]);
  return out.split("\n").includes(CLUSTER);
}

async function axHealthy() {
  return (
    (await clusterExists()) &&
    (await run(["kind", "export", "kubeconfig", "--name", CLUSTER, "--kubeconfig", KUBECONFIG], { quiet: true })) &&
    (await run(kubectl("-n", "ax-system", "rollout", "status", "deployment/ax-server", "--timeout=10s"), { quiet: true }))
  );
}

async function deployPostgres() {
  console.log("==> deploying folie-postgres");
  await must(kubectl("apply", "-f", join(REPO, "deploy/postgres.yaml")));
  // Postgres reads the password only on first volume init: never replace an existing Secret.
  if (!(await run(kubectl("-n", NS, "get", "secret", "folie-postgres"), { quiet: true })))
    await must(kubectl("-n", NS, "create", "secret", "generic", "folie-postgres", `--from-literal=password=${randomBytes(24).toString("hex")}`));
  await must(kubectl("-n", NS, "rollout", "status", "statefulset/folie-postgres", "--timeout=180s"));
}

/** Returns true when the secret changed (the server must restart to see it). */
async function applyAgentEnv(): Promise<boolean> {
  const entries = Object.entries(process.env).filter(([k, v]) => k.startsWith(AGENT_ENV_PREFIX) && v);
  if (entries.length === 0) return false;
  const yaml = await capture(
    kubectl("-n", NS, "create", "secret", "generic", "folie-agent-env", "--dry-run=client", "-o", "yaml", ...entries.map(([k, v]) => `--from-literal=${k}=${v}`)),
  );
  await must(kubectl("apply", "-f", "-"), { stdin: yaml, quiet: true });
  console.log(`==> folie-agent-env: ${entries.map(([k]) => k.slice(AGENT_ENV_PREFIX.length)).join(", ")}`);
  return true;
}

async function deployServer() {
  const images = await buildImages();
  const envChanged = await applyAgentEnv();
  console.log("==> deploying folie-server");
  const manifest = renderManifest(await Bun.file(join(REPO, "deploy/server.yaml")).text(), {
    FOLIE_SERVER_IMAGE: images.server,
    FOLIE_AGENT_IMAGE: images.agent,
  });
  const existed = await run(kubectl("-n", NS, "get", "deployment", "folie-server"), { quiet: true });
  await must(kubectl("apply", "-f", "-"), { stdin: manifest });
  // A new Deployment already starts with the secret; only a running one needs a restart to see a change.
  if (envChanged && existed) await must(kubectl("-n", NS, "rollout", "restart", "deployment/folie-server"));
  await must(kubectl("-n", NS, "rollout", "status", "deployment/folie-server", "--timeout=180s"));
}

export async function up() {
  for (const t of ALL_TOOLS) await ensureTool(t);

  // Re-running must not wipe ax's DB (the setup script does), so skip it when ax is already healthy.
  if (await axHealthy()) console.log("==> ax already running, skipping Substrate/ax install");
  else await must(["bash", "hack/setup-e2e-kind.sh"], { cwd: AX_DIR });

  await deployPostgres();
  await grantFolieServerSubstrateAccess();
  await deployServer();
  console.log(`==> up. try: folie submit "say hello"   (kubectl: ${join(BIN, "kubectl")} --kubeconfig ${KUBECONFIG} --context ${CONTEXT})`);
}

export async function down() {
  await ensureTool("kind");
  if (!(await clusterExists())) return console.log("==> no cluster");
  await must(["kind", "delete", "cluster", "--name", CLUSTER, "--kubeconfig", KUBECONFIG]);
}

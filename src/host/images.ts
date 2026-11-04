// Builds the folie-server and folie-agent images and pushes them to the kind registry.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HOME, REGISTRY, REPO, capture, kubectl, must } from "./env";

export interface ImageRefs {
  server: string;
  agent: string;
}

// An isolated docker config keeps stale credential helpers in ~/.docker from breaking local pushes.
const DOCKER_CONFIG = join(HOME, "docker-config");

async function dockerEnv() {
  await mkdir(DOCKER_CONFIG, { recursive: true });
  const cfg = join(DOCKER_CONFIG, "config.json");
  if (!(await Bun.file(cfg).exists())) await Bun.write(cfg, "{}\n");
  return { DOCKER_CONFIG };
}

async function compile(entry: string, out: string) {
  await must([process.execPath, "build", "--compile", "--target=bun-linux-x64", entry, "--outfile", out], { cwd: REPO });
}

async function buildAndPush(name: string, dockerfile: string, buildArgs: string[] = []): Promise<string> {
  const env = await dockerEnv();
  const tag = `${REGISTRY}/${name}:dev`;
  await must(["docker", "build", "-q", "-t", tag, "-f", dockerfile, ...buildArgs, "."], { cwd: REPO, env });
  await must(["docker", "push", "-q", tag], { cwd: REPO, env });
  const ref = await capture(["docker", "inspect", "--format={{index .RepoDigests 0}}", tag], { env });
  // Substrate only accepts digest-pinned images.
  if (!ref.includes("@sha256:")) throw new Error(`no registry digest for ${tag}`);
  return ref;
}

/** The task-runner image the cluster's ax-server runs tasks on; agents extend it. */
async function axRunnerImage(): Promise<string> {
  const image = await capture(
    kubectl("-n", "ax-system", "get", "deployment", "ax-server", "-o", "jsonpath={.spec.template.spec.containers[0].env[?(@.name=='AX_DEFAULT_TASK_IMAGE')].value}"),
  );
  if (!image) throw new Error("ax-server has no AX_DEFAULT_TASK_IMAGE");
  return image;
}

export async function buildImages(): Promise<ImageRefs> {
  console.log("==> building folie-server and folie-agent");
  await compile("src/server/main.ts", "bin/folie-server");
  await compile("src/agent/main.ts", "bin/folie-agent");
  const base = await axRunnerImage();
  return {
    server: await buildAndPush("folie-server", "deploy/Dockerfile.server"),
    agent: await buildAndPush("folie-agent", "deploy/Dockerfile.agent", ["--build-arg", `BASE_IMAGE=${base}`]),
  };
}

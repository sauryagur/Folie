// Reaches folie-server from the host: FOLIE_SERVER_URL if set, else a short-lived kubectl port-forward.
import { BIN, CONTEXT, HOME, KUBECONFIG, NS } from "./env";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEffectiveConfig } from "../config";

export function operatorTokenFromEnvOrFile(
  env = process.env,
): string | undefined {
  if (env.FOLIE_OPERATOR_TOKEN) return env.FOLIE_OPERATOR_TOKEN;
  const path = join(HOME, "operator-token");
  if (existsSync(path)) return readFileSync(path, "utf8").trim() || undefined;
  return undefined;
}

// withServerUrl remains URL-only; token is read by the CLI layer.
// The helper exists so `folie up` can write ~/.folie/operator-token (0600).

export async function withServerUrl<T>(
  fn: (url: string) => Promise<T>,
): Promise<T> {
  if (process.env.FOLIE_SERVER_URL) {
    const u = new URL(process.env.FOLIE_SERVER_URL);
    const h = u.hostname;
    const local =
      h === "localhost" ||
      h === "127.0.0.1" ||
      h.endsWith(".svc") ||
      h.endsWith(".svc.cluster.local") ||
      h === "folie-server" ||
      h.startsWith("folie-server.");
    if (!local && !process.env.FOLIE_ALLOW_REMOTE_SERVER)
      throw new Error(
        "FOLIE_SERVER_URL points to a non-local host; set FOLIE_ALLOW_REMOTE_SERVER=1 to send the operator token there",
      );
    return fn(process.env.FOLIE_SERVER_URL);
  }

  const config = getEffectiveConfig();
  if (config.execution_profile === "local")
    return fn(`http://127.0.0.1:${config.server_port}`);

  const pf = Bun.spawn(
    [
      `${BIN}/kubectl`,
      "--kubeconfig",
      KUBECONFIG,
      "--context",
      config.kubeconfig_context ?? CONTEXT,
      "-n",
      NS,
      "port-forward",
      "svc/folie-server",
      ":8080",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  try {
    const decoder = new TextDecoder();
    let seen = "";
    for await (const chunk of pf.stdout) {
      seen += decoder.decode(chunk);
      const m = seen.match(/127\.0\.0\.1:(\d+)/);
      if (m) return await fn(`http://127.0.0.1:${m[1]}`);
    }
    throw new Error(
      "kubectl port-forward exited before it was ready (is `folie up` done?)",
    );
  } finally {
    pf.kill();
  }
}

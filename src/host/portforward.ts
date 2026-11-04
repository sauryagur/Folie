// Reaches folie-server from the host: FOLIE_SERVER_URL if set, else a short-lived kubectl port-forward.
import { BIN, CONTEXT, KUBECONFIG, NS } from "./env";

export async function withServerUrl<T>(fn: (url: string) => Promise<T>): Promise<T> {
  if (process.env.FOLIE_SERVER_URL) return fn(process.env.FOLIE_SERVER_URL);

  const pf = Bun.spawn(
    [`${BIN}/kubectl`, "--kubeconfig", KUBECONFIG, "--context", CONTEXT, "-n", NS, "port-forward", "svc/folie-server", ":8080"],
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
    throw new Error("kubectl port-forward exited before it was ready (is `folie up` done?)");
  } finally {
    pf.kill();
  }
}

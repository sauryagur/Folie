// Runtime selection from the environment. Heavy pi imports load only when pi is chosen.
import type { SwarmServer } from "./pi";
import type { Runtime } from "../runtime";
import { echoRuntime } from "./echo";

export interface RuntimeEnv {
  agentName: string;
  runtime: string;
  /** "<provider>/<model id>" */
  model: string;
  workdir: string;
}

export async function createRuntime(env: RuntimeEnv, server: SwarmServer): Promise<Runtime> {
  if (env.runtime === "echo") return echoRuntime;
  if (env.runtime !== "pi") throw new Error(`unknown FOLIE_RUNTIME ${JSON.stringify(env.runtime)} (pi|echo)`);

  const [{ builtinModels }, { createCodingTools }, { PiRuntime }] = await Promise.all([
    import("@earendil-works/pi-ai/providers/all"),
    import("@earendil-works/pi-coding-agent"),
    import("./pi"),
  ]);
  const slash = env.model.indexOf("/");
  if (slash < 1) throw new Error(`FOLIE_MODEL must be "<provider>/<model>", got ${JSON.stringify(env.model)}`);
  const models = builtinModels();
  const model = models.getModel(env.model.slice(0, slash), env.model.slice(slash + 1));
  if (!model) throw new Error(`unknown model ${env.model}`);
  return new PiRuntime({
    agentName: env.agentName,
    model,
    streamFn: models.streamSimple.bind(models),
    codingTools: createCodingTools(env.workdir) as never,
    workdir: env.workdir,
    server,
  });
}

// Runtime selection from the environment. Heavy pi imports load only when pi is chosen.
import type { SwarmServer } from "./pi";
import type { Runtime } from "../runtime";
import type { FakeTurn } from "./fake-strands-model";
import { echoRuntime } from "./echo";

export interface RuntimeEnv {
  agentName: string;
  runtime: string;
  /** "<provider>/<model id>" */
  model: string;
  workdir: string;
}

export async function createRuntime(
  env: RuntimeEnv,
  server: SwarmServer,
): Promise<Runtime> {
  if (env.runtime === "echo") return echoRuntime;
  if (env.runtime === "strands") {
    const { StrandsRuntime } = await import("./strands");
    const fakeTurns = process.env.FOLIE_FAKE_TURNS;
    if (fakeTurns) {
      const { FakeStrandsModel } = await import("./fake-strands-model");
      const model = new FakeStrandsModel();
      model.setTurns(...(JSON.parse(fakeTurns) as FakeTurn[]));
      return new StrandsRuntime({
        agentName: env.agentName,
        model,
        workdir: env.workdir,
        server,
      });
    }
    const [provider, ...modelIdParts] = env.model.split("/");
    const modelId = modelIdParts.join("/");
    if (provider !== "openrouter" || !modelId)
      throw new Error(
        `Strands currently requires FOLIE_MODEL "openrouter/<model id>", got ${JSON.stringify(env.model)}`,
      );
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    return new StrandsRuntime({
      agentName: env.agentName,
      model: new OpenAIModel({
        api: "chat",
        modelId,
        apiKey: process.env.OPENROUTER_API_KEY,
        clientConfig: { baseURL: "https://openrouter.ai/api/v1" },
      }),
      workdir: env.workdir,
      server,
    });
  }
  if (env.runtime !== "pi")
    throw new Error(
      `unknown FOLIE_RUNTIME ${JSON.stringify(env.runtime)} (strands|pi|echo)`,
    );

  const [{ builtinModels }, { createCodingTools }, { PiRuntime }] =
    await Promise.all([
      import("@earendil-works/pi-ai/providers/all"),
      import("@earendil-works/pi-coding-agent"),
      import("./pi"),
    ]);
  const slash = env.model.indexOf("/");
  if (slash < 1)
    throw new Error(
      `FOLIE_MODEL must be "<provider>/<model>", got ${JSON.stringify(env.model)}`,
    );
  const models = builtinModels();
  const model = models.getModel(
    env.model.slice(0, slash),
    env.model.slice(slash + 1),
  );
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

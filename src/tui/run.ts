// Starts the TUI on the real terminal. Imported lazily by the CLI so scripted commands never load the native core.
import { createCliRenderer } from "@opentui/core";
import type { FolieClient } from "../shared/client";
import { createApp } from "./app";

export async function runTui(client: FolieClient): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const done = Promise.withResolvers<void>();
  let app: ReturnType<typeof createApp> | undefined;
  const quit = () => {
    app?.stop();
    renderer.destroy();
    done.resolve();
  };
  app = createApp(renderer, { api: client, onQuit: quit });
  await app.refresh();
  await done.promise;
}

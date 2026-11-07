// Starts the TUI on the real terminal. Imported lazily by the CLI so scripted commands never load the native core.
import { createCliRenderer } from "@opentui/core";
import type { FolieClient } from "../shared/client";
import { createApp, type App } from "./app";

export async function runTui(client: FolieClient): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const done = Promise.withResolvers<void>();
  let app: App | undefined;
  let destroyed = false;
  const quit = () => {
    app?.stop();
    if (!destroyed) { destroyed = true; renderer.destroy(); }
    done.resolve();
  };
  // Crash-safe restore: kill -9 can't be handled, but signals and uncaught errors must not leave raw mode/alt-screen behind.
  process.once("SIGTERM", quit);
  process.once("SIGINT", quit);
  process.once("uncaughtException", (e) => {
    console.error(e);
    quit();
  });
  try {
    app = createApp(renderer, { api: client, onQuit: quit });
    await app.refresh();
    await done.promise;
  } finally {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("uncaughtException");
  }
}

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each DB-backed file boots its own in-process Postgres (wasm); many at once starve each other, so cap workers
  // and give the one-time boot in beforeAll room.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000, maxWorkers: 4 },
});

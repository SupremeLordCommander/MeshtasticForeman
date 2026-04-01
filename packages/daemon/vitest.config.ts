import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Each file runs in its own fork so in-memory PGlite state is isolated
    pool: "forks",
  },
});

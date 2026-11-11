import { defineConfig } from "vitest/config";

// #813: the recall eval runs ONLY through this config, never in the default suite: it
// needs the embedding cache from eval/embed813.mjs (real Workers AI calls).
export default defineConfig({
  test: {
    environment: "node",
    include: ["eval/**/*.eval.mjs"],
    setupFiles: ["./test-setup/workers-pbkdf2-cap.ts"],
    testTimeout: 600_000,
  },
});

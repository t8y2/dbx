import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/desktop/src"),
      "@dbx-app/mongo-shell": path.resolve(__dirname, "packages/mongo-shell/src/index.ts"),
    },
  },
  test: {
    include: ["packages/app-tests/*.test.ts", "apps/desktop/src/**/*.spec.ts", "docs/lib/*.test.ts"],
    globalSetup: "packages/test-globals.ts",
    // Large store modules are dynamically imported in many specs. Limiting
    // concurrency prevents those imports from starving timers and making
    // otherwise deterministic deferred-promise tests exceed Vitest's timeout.
    maxWorkers: 4,
  },
});

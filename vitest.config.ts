import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "apps/desktop/src"),
      "@dbx-app/mongo-shell": path.resolve(import.meta.dirname, "packages/mongo-shell/src/index.ts"),
    },
  },
  test: {
    include: ["packages/app-tests/*.test.ts", "apps/desktop/src/**/*.spec.ts", "docs/lib/*.test.ts"],
    globalSetup: "packages/test-globals.ts",
    // Many specs dynamically import the large store modules (connectionStore,
    // queryStore) inside test bodies; when several workers pay that first
    // import at once, CPU contention can stall a worker's event loop past the
    // old 5s default and flake deferred-promise tests. A 10s timeout absorbs
    // that without capping throughput, so workers can scale past 4. CI keeps
    // 4 workers: its 4-vCPU runners already run vue-tsc/oxlint/oxfmt
    // concurrently with vitest via `pnpm check`.
    testTimeout: 10_000,
    maxWorkers: process.env.CI ? 4 : 8,
  },
});

import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/desktop/src"),
    },
  },
  test: {
    include: ["packages/app-tests/*.test.ts", "packages/node-core/tests/*.test.ts", "apps/desktop/src/**/*.spec.ts", "docs/lib/*.test.ts"],
    globalSetup: "packages/test-globals.ts",
  },
});

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
const isTauri = !!host || !!process.env.TAURI_ENV_ARCH;
const manualChunks: Record<string, string[]> = {
  codemirror: ["codemirror", "@codemirror/lang-sql", "@codemirror/view", "@codemirror/state", "@codemirror/autocomplete", "@codemirror/commands", "@codemirror/theme-one-dark"],
  "vue-echarts": ["vue-echarts"],
  ui: ["reka-ui"],
  marked: ["marked"],
};

function chunkNameForEchartsModule(id: string): string {
  const echartsPath = id.split("/node_modules/echarts/").pop() ?? "";

  if (echartsPath === "charts.js" || echartsPath.startsWith("lib/chart/")) {
    return "echarts-charts";
  }

  if (echartsPath === "components.js" || echartsPath.startsWith("lib/component/")) {
    return "echarts-components";
  }

  if (echartsPath === "renderers.js" || echartsPath.startsWith("lib/renderer/")) {
    return "echarts-renderers";
  }

  return "echarts-core";
}

function chunkNameForModule(id: string): string | undefined {
  const normalizedId = id.replaceAll("\\", "/");

  if (normalizedId.includes("/node_modules/echarts/")) {
    return chunkNameForEchartsModule(normalizedId);
  }

  for (const [chunkName, packages] of Object.entries(manualChunks)) {
    if (packages.some((pkg) => normalizedId.includes(`/node_modules/${pkg}/`))) {
      return chunkName;
    }
  }

  return undefined;
}

export default defineConfig(async () => ({
  root: __dirname,
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: chunkNameForModule,
      },
    },
  },
  server: {
    port: isTauri ? 1420 : undefined,
    strictPort: isTauri,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    proxy: isTauri
      ? undefined
      : {
          "/api": {
            target: "http://localhost:4224",
            changeOrigin: true,
          },
        },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

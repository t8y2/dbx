import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
const isTauri = !!host || !!process.env.TAURI_ENV_ARCH;
const configuredBasePath = process.env.VITE_DBX_BASE_PATH || process.env.DBX_PUBLIC_BASE_PATH;
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

function normalizeViteBase(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "./";
  if (trimmed === "." || trimmed === "./") return "./";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

const viteBase = normalizeViteBase(configuredBasePath);
const publicBasePath = viteBase.startsWith("/") ? viteBase.replace(/\/+$/, "") : "";
const apiProxyPath = publicBasePath ? `${publicBasePath}/api` : "/api";
const backendUrl = process.env.DBX_BACKEND_URL || "http://localhost:4224";

export default defineConfig(async () => ({
  root: __dirname,
  base: viteBase,
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Prefer package source during app dev so shell parse changes need no rebuild.
      "@dbx-app/mongo-shell": path.resolve(__dirname, "../../packages/mongo-shell/src/index.ts"),
    },
  },
  clearScreen: false,
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    // Large generated syntax grammars are already isolated and loaded on demand.
    chunkSizeWarningLimit: 800,
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
    proxy: {
      [apiProxyPath]: {
        target: backendUrl,
        changeOrigin: true,
        ws: true,
        rewrite: publicBasePath ? (requestPath) => requestPath.slice(publicBasePath.length) || "/" : undefined,
      },
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

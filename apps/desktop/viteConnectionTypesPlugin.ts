import { execFileSync } from "node:child_process";
import { extname, relative, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";

const repoRoot = resolve(import.meta.dirname, "../..");
const connectionTypesDirectory = resolve(repoRoot, "plugins/connection-types");
const generator = resolve(repoRoot, "scripts/sync-connection-types.mjs");

function syncConnectionTypes() {
  execFileSync(process.execPath, [generator], { cwd: repoRoot, stdio: "inherit" });
}

function isConnectionTypeDescriptor(path: string): boolean {
  const relativePath = relative(connectionTypesDirectory, path);
  return relativePath !== "" && !relativePath.startsWith("..") && [".yaml", ".yml"].includes(extname(path));
}

function watchConnectionTypes(server: ViteDevServer) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  server.watcher.add(connectionTypesDirectory);
  server.watcher.on("all", (_event, path) => {
    if (!isConnectionTypeDescriptor(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        syncConnectionTypes();
      } catch (error) {
        server.config.logger.error(error instanceof Error ? error.message : String(error));
      }
    }, 50);
  });
  server.httpServer?.once("close", () => {
    if (timer) clearTimeout(timer);
  });
}

export function connectionTypesPlugin(): Plugin {
  return {
    name: "dbx-connection-types",
    configResolved: syncConnectionTypes,
    configureServer: watchConnectionTypes,
  };
}

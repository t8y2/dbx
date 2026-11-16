import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import configFactory from "../../apps/desktop/vite.config.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
execFileSync(process.execPath, ["scripts/sync-connection-types.mjs", "--check"], { cwd: repository, stdio: ["ignore", "pipe", "inherit"] });
const config = await configFactory({ command: "build", mode: "production" });
const result = await build({
  ...config,
  configFile: false,
  logLevel: "error",
  plugins: config.plugins.filter((plugin) => plugin?.name !== "dbx-connection-types"),
  build: { ...config.build, write: false, emptyOutDir: false, reportCompressedSize: false },
});
const chunks = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output).filter((output) => output.type === "chunk");
const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
const sourceChunk = (suffix) => chunks.find((chunk) => Object.keys(chunk.modules).some((id) => id.endsWith(suffix)));
const entry = chunks.find((chunk) => chunk.isEntry && chunk.facadeModuleId?.endsWith("/index.html"));
const gate = sourceChunk("/src/StartupGate.vue");
const locale = sourceChunk("/src/i18n/index.ts");
const app = sourceChunk("/src/App.vue");
const chinese = sourceChunk("/src/i18n/locales/zh-CN.ts");
if (!entry || !gate || !locale || !app || !chinese) throw new Error("Startup bundle entrypoints were not found");

function summarize(phase, seeds) {
  const visited = new Set();
  function visit(name) {
    if (visited.has(name) || !byName.has(name)) return;
    visited.add(name);
    byName.get(name).imports.forEach(visit);
  }
  seeds.forEach((chunk) => visit(chunk.fileName));
  const dependencies = [...visited].map((name) => byName.get(name));
  const files = dependencies.map((chunk) => ({ file: chunk.fileName, bytes: Buffer.byteLength(chunk.code), gzipBytes: gzipSync(chunk.code).length }));
  const modules = dependencies.flatMap((chunk) => Object.keys(chunk.modules));
  return {
    phase,
    jsChunks: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    largestFiles: files.sort((left, right) => right.bytes - left.bytes).slice(0, 8),
    includes: Object.fromEntries(["settingsStore.ts", "connectionStore.ts", "queryStore.ts", "QueryEditor.vue", "/node_modules/@codemirror/"].map((pattern) => [pattern, modules.some((id) => id.includes(pattern))])),
  };
}

console.log(
  JSON.stringify(
    {
      kind: "static-js-dependencies-not-startup-timing",
      phases: [summarize("entry", [entry]), summarize("startup-gate-en", [entry, gate, locale]), summarize("startup-gate-zh-CN", [entry, gate, locale, chinese]), summarize("app-en", [entry, gate, locale, app]), summarize("app-zh-CN", [entry, gate, locale, app, chinese])],
    },
    null,
    2,
  ),
);

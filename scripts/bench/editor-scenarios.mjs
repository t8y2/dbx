// Drives scripts/bench/editor-scenarios.ts in headless Chrome over CDP and prints,
// per scenario phase, the timings plus the top self-time functions from a CPU profile.
// Usage: node scripts/bench/editor-scenarios.mjs [scenario-name ...]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { scenarios } from "./editor-scenarios.definitions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const page = `<!doctype html><html><head><meta charset="utf-8"><title>SQL editor scenarios</title></head><body>
<pre id="report">loading</pre><div id="editor"></div>
<script type="module" src="/@fs/${root}/scripts/bench/editor-scenarios.ts"></script></body></html>`;

const server = await createServer({
  configFile: path.join(root, "apps/desktop/vite.config.ts"),
  server: { host: "127.0.0.1", port: 5182, strictPort: true, open: false },
  logLevel: "error",
  plugins: [
    {
      name: "editor-scenarios",
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== "/editor-scenarios.html") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(await vite.transformIndexHtml(request.url, page));
        });
      },
    },
  ],
});
await server.listen();

const userDataDir = mkdtempSync(path.join(os.tmpdir(), "dbx-bench-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${userDataDir}`, "--no-first-run", "--disable-gpu-vsync", "--window-size=1400,900", "about:blank"], { stdio: "ignore" });

async function cleanup() {
  chrome.kill();
  await server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

async function connect() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
      const target = targets.find((item) => item.type === "page");
      if (target) return target.webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not start");
}

const socket = new WebSocket(await connect());
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

function selfTimes(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const deltas = profile.timeDeltas;
  profile.samples.forEach((id, index) => {
    const node = byId.get(id);
    const frame = node.callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").slice(-2).join("/").replace(/\?.*$/, "")}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0) / 1000);
  });
  return [...self.entries()].sort((a, b) => b[1] - a[1]);
}

const only = process.argv.slice(2);
try {
  await send("Page.enable");
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 200 });
  for (const scenario of scenarios) {
    if (only.length && !only.includes(scenario.name)) continue;
    console.log(`\n=== ${scenario.name}`);
    await send("Page.navigate", { url: "http://127.0.0.1:5182/editor-scenarios.html" });
    for (let attempt = 0; attempt < 600; attempt++) {
      if ((await evaluate("document.querySelector('#report')?.textContent")) === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const phase of scenario.phases) {
      await send("Profiler.start");
      const result = await evaluate(`(async () => JSON.stringify(await (${phase.run})))()`);
      const { profile } = await send("Profiler.stop");
      console.log(`-- ${phase.name}: ${result}`);
      if (!process.env.NO_PROFILE) {
        for (const [name, ms] of selfTimes(profile).slice(0, Number(process.env.TOP ?? 8))) console.log(`     ${ms.toFixed(0).padStart(6)} ms  ${name}`);
      }
    }
    await evaluate("window.bench.unmountAll()");
  }
} finally {
  await cleanup();
  process.exit(0);
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const page = `<!doctype html><html><head><meta charset="utf-8"><title>SQL editor typing benchmark</title></head><body>
<h1>SQL editor typing benchmark</h1><button id="run">Run benchmark</button><pre id="report">Ready</pre><div id="editor" style="height:500px;overflow:hidden"></div>
<script type="module" src="/@fs/${root}/scripts/bench/editor-typing.ts"></script></body></html>`;
const server = await createServer({
  configFile: path.join(root, "apps/desktop/vite.config.ts"),
  server: { host: "127.0.0.1", port: 5181, strictPort: true, open: false },
  plugins: [
    {
      name: "editor-typing-benchmark",
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== "/editor-typing-benchmark.html") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(await vite.transformIndexHtml(request.url, page));
        });
      },
    },
  ],
});
await server.listen();
console.log("Open http://127.0.0.1:5181/editor-typing-benchmark.html and click Run benchmark.");

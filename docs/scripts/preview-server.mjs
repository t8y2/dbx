// Local preview for the static export, mimicking Cloudflare Workers asset
// resolution: exact file first, then /foo -> /foo.html, then /foo/ ->
// /foo/index.html, and unknown paths fall back to 404.html like
// not_found_handling: "404-page". Run `pnpm build` before this script.
//
// It also mirrors the production worker's /api/agent-asset proxy so the
// drivers page custom-bundle builder works locally against GitHub sources.
//
// Usage: node scripts/preview-server.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";

const ROOT = resolve(import.meta.dirname, "../out");
const PORT = Number(process.argv[2] ?? 3000);
const AGENT_ASSET_URL_PATTERN = /^https:\/\/github\.com\/t8y2\/dbx\/releases\/download\/(agents-v[0-9][A-Za-z0-9._-]*|agents-latest)\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:tar\.zst|zip|jar|exe|json))$/;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json",
  ".xml": "application/xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

async function tryFile(rel) {
  const file = join(ROOT, rel);
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    return { file, type: types[extname(file)] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

async function proxyAgentAsset(req, res) {
  const target = new URL(req.url, "http://localhost").searchParams.get("url") ?? "";
  if (!AGENT_ASSET_URL_PATTERN.test(target)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Unsupported asset URL" }));
  }
  const upstream = await fetch(target, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Asset unavailable" }));
  }
  const headers = {
    "content-type": "application/octet-stream",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  };
  if (upstream.headers.has("content-length")) headers["content-length"] = upstream.headers.get("content-length");
  res.writeHead(upstream.status, headers);
  if (req.method === "HEAD") return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path === "/api/agent-asset" && (req.method === "GET" || req.method === "HEAD")) {
      return await proxyAgentAsset(req, res);
    }
    if (path.includes("..")) {
      res.writeHead(400);
      return res.end();
    }
    const hit =
      (await tryFile(path)) ??
      (path.endsWith("/") ? await tryFile(join(path, "index.html")) : await tryFile(`${path}.html`));
    if (hit) {
      res.writeHead(200, { "content-type": hit.type, "cache-control": "no-store" });
      return res.end(await readFile(hit.file));
    }
    const fallback = await tryFile("404.html");
    if (fallback) {
      res.writeHead(404, { "content-type": fallback.type, "cache-control": "no-store" });
      return res.end(await readFile(fallback.file));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404");
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
}).listen(PORT, () => {
  console.log(`Preview serving ${ROOT} at http://localhost:${PORT}`);
});

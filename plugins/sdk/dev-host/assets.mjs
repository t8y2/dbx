import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
// Keep UI entrypoints and assets within the same bound as the installed host's
// MAX_PLUGIN_UI_ASSET_BYTES (crates/dbx-plugin-runtime/src/plugins/assets.rs).
const MAX_PLUGIN_UI_ASSET_BYTES = 32 * 1024 * 1024;

export async function readAsset(root, path) {
  if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path)) throw new Error("Invalid asset path");
  const base = await realpath(root),
    file = await realpath(resolve(base, path));
  const rel = relative(base, file);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Asset is outside UI root");
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Asset is not a file");
  if (info.size > MAX_PLUGIN_UI_ASSET_BYTES) throw new Error(`Asset exceeds ${MAX_PLUGIN_UI_ASSET_BYTES} byte limit`);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  return { dataBase64: (await readFile(file)).toString("base64"), contentType: types[extname(file)] || "application/octet-stream" };
}

import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
export async function readAsset(root, path) {
  if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path)) throw new Error("Invalid asset path");
  const base = await realpath(root),
    file = await realpath(resolve(base, path));
  const rel = relative(base, file);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Asset is outside UI root");
  const info = await stat(file);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("Asset exceeds limit or is not a file");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  return { dataBase64: (await readFile(file)).toString("base64"), contentType: types[extname(file)] || "application/octet-stream" };
}

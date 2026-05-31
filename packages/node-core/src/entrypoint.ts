import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  return normalizeEntryPath(fileURLToPath(moduleUrl)) === normalizeEntryPath(argvPath);
}

function normalizeEntryPath(path: string): string {
  const normalized = normalize(realpathIfPossible(resolve(path)));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

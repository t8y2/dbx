import type { KvValue } from "@/lib/backend/api";

export type KvExportScopeKind = "key" | "prefix";

export interface KvExportScopeRequest {
  path: string;
  kind: KvExportScopeKind;
  keyBytes?: KvValue | null;
}

export function kvDirectoryPrefix(path: string): string {
  if (!path || path === "/") return path;
  return `${path.replace(/\/+$/, "")}/`;
}

export function isKeyInKvExportScope(key: string, request: KvExportScopeRequest): boolean {
  if (request.kind === "key") return key === request.path;
  return key === request.path || key.startsWith(kvDirectoryPrefix(request.path));
}

export function kvExportFilenameStem(path: string): string {
  const normalized = path
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.slice(0, 80) || "root";
}

export function kvValueByteIdentity(value: KvValue): string {
  const bytes = value.encoding === "utf8" ? new TextEncoder().encode(value.data) : Uint8Array.from(atob(value.data.replace(/\s+/g, "")), (character) => character.charCodeAt(0));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

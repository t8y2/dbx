import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const LAST_EXPORT_DIRECTORY_STORAGE_KEY = "dbx-last-export-directory";

export function isAbsolutePath(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\\\")) return true;
  return /^[a-zA-Z]:[/\\]/.test(trimmed);
}

export function getParentDirectory(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return "";
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return trimmed.slice(0, 1);
  if (/^[a-zA-Z]:$/.test(trimmed.slice(0, lastSlash))) {
    return trimmed.slice(0, lastSlash + 1);
  }
  return trimmed.slice(0, lastSlash);
}

export function joinExportPath(directory: string, fileName: string): string {
  const trimmedDir = directory.trim();
  const trimmedName = fileName.trim();
  if (!trimmedDir) return trimmedName;
  if (!trimmedName) return trimmedDir;
  if (isAbsolutePath(trimmedName)) return trimmedName;
  const separator = trimmedDir.includes("\\") && !trimmedDir.includes("/") ? "\\" : "/";
  return trimmedDir.endsWith("/") || trimmedDir.endsWith("\\") ? `${trimmedDir}${trimmedName}` : `${trimmedDir}${separator}${trimmedName}`;
}

export function getLastExportDirectory(): string {
  try {
    return safeLocalStorageGet(LAST_EXPORT_DIRECTORY_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function setLastExportDirectory(directory: string): void {
  const trimmed = directory.trim();
  if (!trimmed) return;
  try {
    safeLocalStorageSet(LAST_EXPORT_DIRECTORY_STORAGE_KEY, trimmed);
  } catch {
    // Ignore storage write errors
  }
}

export function clearLastExportDirectory(): void {
  try {
    safeLocalStorageRemove(LAST_EXPORT_DIRECTORY_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function resolveExportDefaultPath(fileName: string, options?: { preferredPath?: string }): string {
  const trimmedName = fileName.trim();
  if (isAbsolutePath(trimmedName)) {
    return trimmedName;
  }
  const preferred = options?.preferredPath?.trim();
  if (preferred) {
    return joinExportPath(preferred, trimmedName);
  }
  const lastDir = getLastExportDirectory();
  if (lastDir) {
    return joinExportPath(lastDir, trimmedName);
  }
  return trimmedName;
}

export function rememberLastExportPath(savedPath: string | null | undefined): void {
  if (!savedPath || typeof savedPath !== "string") return;
  const dir = getParentDirectory(savedPath);
  if (dir) {
    setLastExportDirectory(dir);
  }
}

export async function promptExportSavePath(options: { defaultFileName: string; filters?: Array<{ name: string; extensions: string[] }>; preferredPath?: string }): Promise<string | null> {
  let preferred = options.preferredPath?.trim();
  if (!preferred) {
    try {
      const { getActivePinia } = await import("pinia");
      if (getActivePinia()) {
        const { useSettingsStore } = await import("@/stores/settingsStore");
        preferred = useSettingsStore().editorSettings.preferredExportPath?.trim();
      }
    } catch {
      // Pinia not active or store not accessible
    }
  }
  const defaultPath = resolveExportDefaultPath(options.defaultFileName, { preferredPath: preferred });
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath,
    filters: options.filters,
  });
  if (typeof path === "string" && path.trim()) {
    rememberLastExportPath(path);
    return path;
  }
  return null;
}

let lastRevealedPath = "";
let lastRevealedTime = 0;

export async function revealExportedPath(path: string): Promise<void> {
  const trimmed = path?.trim();
  if (!trimmed) return;
  const now = Date.now();
  if (trimmed === lastRevealedPath && now - lastRevealedTime < 2000) {
    return;
  }
  lastRevealedPath = trimmed;
  lastRevealedTime = now;
  const { revealPathInFileManager } = await import("@/lib/backend/api");
  await revealPathInFileManager(trimmed);
}

export async function autoRevealExportedPathIfConfigured(path: string | null | undefined): Promise<boolean> {
  const trimmed = path?.trim();
  if (!trimmed) return false;
  const { isTauriRuntime } = await import("@/lib/backend/tauriRuntime");
  if (!isTauriRuntime()) return false;
  try {
    const { getActivePinia } = await import("pinia");
    if (!getActivePinia()) return false;
    const { useSettingsStore } = await import("@/stores/settingsStore");
    if (!useSettingsStore().editorSettings.autoOpenExportFolder) return false;
    await revealExportedPath(trimmed);
    return true;
  } catch {
    return false;
  }
}

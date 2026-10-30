import type { JavaRuntimeMode } from "@/lib/backend/tauri";

/**
 * The installed-runtime rows only describe the JDKs Dbx manages itself. Once
 * the user points Dbx at a custom JRE or the system Java, those rows describe
 * something the app is not going to use, and showing them under the selector
 * reads as a contradiction (#13815).
 */
export function showsInstalledJreRows(mode: JavaRuntimeMode | undefined, installedCount: number): boolean {
  return (mode ?? "managed") === "managed" && installedCount > 0;
}

import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/** Directory (under the app data dir) where oversized open-tab SQL bodies are spilled. */
export const OPEN_TAB_RECOVERY_DIR = "open-tab-recovery";

function safeFileStem(tabId: string): string {
  return tabId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "tab";
}

/**
 * Persist one oversized editor SQL body next to the app data so the session
 * snapshot stored in `dbx.db` stays small. Returns the absolute file path, or
 * `null` when unavailable (web runtime, permission errors) — in that case the
 * tab simply restores with a truncated preview and no recovery path.
 */
export async function writeOpenTabSqlRecovery(tabId: string, sql: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const [{ appDataDir, join }, { exists, mkdir, writeTextFile }] = await Promise.all([import("@tauri-apps/api/path"), import("@tauri-apps/plugin-fs")]);
    const directory = await join(await appDataDir(), OPEN_TAB_RECOVERY_DIR);
    if (!(await exists(directory))) await mkdir(directory, { recursive: true });
    const path = await join(directory, `${safeFileStem(tabId)}.sql`);
    await writeTextFile(path, sql);
    return path;
  } catch (error) {
    console.warn("[DBX][open-tabs:sql-spill:error]", error);
    return null;
  }
}

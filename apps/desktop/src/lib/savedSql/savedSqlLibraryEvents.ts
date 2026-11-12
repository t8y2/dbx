import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const SAVED_SQL_LIBRARY_CHANGED_EVENT = "dbx:saved-sql-library-changed";

interface SavedSqlLibraryChange {
  sourceWindow: string;
}

/** Publish only after a durable write; notification failure cannot undo it. */
export async function notifySavedSqlLibraryChanged(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const [{ emit }, { getCurrentWindow }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/window")]);
    await emit<SavedSqlLibraryChange>(SAVED_SQL_LIBRARY_CHANGED_EVENT, { sourceWindow: getCurrentWindow().label });
  } catch (error) {
    console.warn("[DBX][saved-sql:notify:error]", error);
  }
}

export async function subscribeSavedSqlLibraryChanges(refresh: () => Promise<void>): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const [{ listen }, { getCurrentWindow }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/window")]);
  const sourceWindow = getCurrentWindow().label;
  return listen<SavedSqlLibraryChange>(SAVED_SQL_LIBRARY_CHANGED_EVENT, (event) => {
    // The originating store already has the saved content. Reloading it would
    // discard its lazy-content cache and make directory sync load every file.
    if (event.payload?.sourceWindow === sourceWindow) return;
    void refresh().catch((error) => console.warn("[DBX][saved-sql:refresh:error]", error));
  });
}

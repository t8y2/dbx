import { ref, watch } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { SqlFileSearchMode } from "@/lib/sql/sqlFileTreeFilter";

export function useSqlPanelSearchMode(panel: "file" | "library") {
  const key = `dbx-sql-${panel}-search-mode`;
  const mode = ref<SqlFileSearchMode>(safeLocalStorageGet(key) === "content" ? "content" : "name");
  watch(mode, (value) => safeLocalStorageSet(key, value), { flush: "sync" });
  return mode;
}

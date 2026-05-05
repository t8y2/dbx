import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import type { QueryTab } from "@/types/database";

export function connectionDisplayName(connectionId: string): string {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.name || connectionId;
}

export function connectionColor(connectionId: string): string {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.color || "";
}

export function databaseDisplayNameForTab(connectionId: string, database: string): string {
  const { t } = useI18n();
  const connectionStore = useConnectionStore();
  const connection = connectionStore.getConfig(connectionId);
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  return database || t("editor.noDatabase");
}

export function isPreviewTab(tab: QueryTab): boolean {
  const connectionStore = useConnectionStore();
  const config = connectionStore.getConfig(tab.connectionId);
  return !!config?.name.startsWith("[Preview]");
}

export function tabDisplayTitle(tab: QueryTab): string {
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database);
  if (isPreviewTab(tab)) return tab.title;
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    return tab.tableMeta.tableName;
  }
  if (tab.mode === "query") {
    return `${connectionDisplayName(tab.connectionId)} | ${database}`;
  }
  if (tab.mode === "mongo" && tab.sql) {
    return `${database} | ${tab.sql}`;
  }
  if (tab.mode === "redis") {
    return `${connectionDisplayName(tab.connectionId)} | ${database}`;
  }
  return tab.title;
}

export function tabTooltipLines(tab: QueryTab): { label: string; value: string }[] {
  const { t } = useI18n();
  const connName = connectionDisplayName(tab.connectionId);
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database);
  const lines: { label: string; value: string }[] = [
    { label: t("tabs.tooltipConnection"), value: connName },
    { label: t("tabs.tooltipDatabase"), value: database },
  ];
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    lines.push({ label: t("tabs.tooltipTable"), value: tab.tableMeta.tableName });
  }
  if (tab.mode === "mongo" && tab.sql) {
    lines.push({ label: t("tabs.tooltipCollection"), value: tab.sql });
  }
  return lines;
}

export function tabModeLabel(tab: QueryTab): string {
  const { t } = useI18n();
  if (tab.mode === "data") return t("tabs.table");
  if (tab.mode === "query") return t("tabs.sql");
  if (tab.mode === "mongo") return t("tabs.mongo");
  if (tab.mode === "redis") return t("tabs.redis");
  return tab.mode;
}

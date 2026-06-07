import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryTab } from "@/types/database";

type Translate = (key: string, params?: Record<string, unknown>) => string;

export function connectionDisplayName(connectionId: string): string {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.name || connectionId;
}

export function connectionColor(connectionId: string): string {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.color || "";
}

export function databaseDisplayNameForTab(connectionId: string, database: string, t: Translate): string {
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

function queryTitle(tab: QueryTab): string | undefined {
  if (tab.customTitle || tab.savedSqlId || tab.objectSource) return tab.title.trim() || undefined;
  return undefined;
}

export function tabDisplayTitle(tab: QueryTab, t: Translate): string {
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database, t);
  const settingsStore = useSettingsStore();
  const compact = settingsStore.editorSettings.compactTabTitle;
  if (isPreviewTab(tab)) return tab.title;
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    if (compact) return tab.tableMeta.tableName;
    const suffix =
      tab.tableMeta.schema && tab.tableMeta.schema !== tab.database
        ? `@${database}.${tab.tableMeta.schema}`
        : `@${database}`;
    return `${tab.tableMeta.tableName}${suffix}`;
  }
  if (tab.mode === "query") {
    const title = queryTitle(tab);
    if (title) return title;
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@${database}`;
  }
  if (tab.mode === "mongo" && tab.sql) {
    if (compact) return tab.sql;
    return `${tab.sql}@${database}`;
  }
  if (tab.mode === "redis") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@${database}`;
  }
  if (tab.mode === "objects") {
    const schema = tab.objectBrowser?.schema;
    if (compact) return schema || tab.title;
    return schema ? `${schema}@${database}` : `${tab.title}@${database}`;
  }
  return tab.title;
}

export function tabTooltipLines(tab: QueryTab, t: Translate): { label: string; value: string }[] {
  const connName = connectionDisplayName(tab.connectionId);
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database, t);
  const lines: { label: string; value: string }[] = [
    { label: t("tabs.tooltipConnection"), value: connName },
    { label: t("tabs.tooltipDatabase"), value: database },
  ];
  if (tab.mode === "query" && queryTitle(tab)) {
    lines.unshift({ label: t("tabs.tooltipTitle"), value: tab.title });
  }
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    lines.push({ label: t("tabs.tooltipTable"), value: tab.tableMeta.tableName });
  }
  if (tab.mode === "mongo" && tab.sql) {
    lines.push({ label: t("tabs.tooltipCollection"), value: tab.sql });
  }
  if (tab.mode === "objects" && tab.objectBrowser?.schema) {
    lines.push({ label: t("tabs.tooltipSchema"), value: tab.objectBrowser.schema });
  }
  return lines;
}

export function shouldShowTabOverflowControls(
  tabCount: number,
  hasTabOverflow: boolean,
  canScrollLeft: boolean,
  canScrollRight: boolean,
): boolean {
  return tabCount > 0 && (hasTabOverflow || canScrollLeft || canScrollRight);
}

export function tabModeLabel(tab: QueryTab, t: Translate): string {
  if (tab.mode === "data") return t("tabs.table");
  if (tab.mode === "query") return t("tabs.sql");
  if (tab.mode === "mongo") return t("tabs.mongo");
  if (tab.mode === "redis") return t("tabs.redis");
  if (tab.mode === "objects") return t("tabs.objects");
  return tab.mode;
}

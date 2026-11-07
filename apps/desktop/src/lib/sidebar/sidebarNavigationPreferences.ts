import type { EditorSettings } from "@/stores/settingsStore";
export function sidebarNavigationSettings(settings: Pick<EditorSettings, "sidebarObjectDisplay" | "sidebarObjectInfoMode" | "sidebarHiddenTablePrefixes">, _connectionId?: string) {
  return {
    sidebarObjectDisplay: settings.sidebarObjectDisplay,
    sidebarObjectInfoMode: settings.sidebarObjectInfoMode,
    sidebarHiddenTablePrefixes: settings.sidebarHiddenTablePrefixes,
  };
}

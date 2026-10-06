import type { GlobalNavigationEntry } from "./navigationEntry";

export interface GlobalNavigationExecutorHandlers {
  activateQueryTab: (tabId: string) => boolean;
  activateSettings: () => void;
  activateDriverStore: () => void;
  activatePluginCenter: () => void;
}

export async function restoreGlobalNavigationEntry(entry: GlobalNavigationEntry, handlers: GlobalNavigationExecutorHandlers): Promise<boolean> {
  switch (entry.surface) {
    case "query":
      return Boolean(entry.tabId && handlers.activateQueryTab(entry.tabId));
    case "settings":
      handlers.activateSettings();
      return true;
    case "driverStore":
      handlers.activateDriverStore();
      return true;
    case "pluginCenter":
      handlers.activatePluginCenter();
      return true;
    default:
      return false;
  }
}

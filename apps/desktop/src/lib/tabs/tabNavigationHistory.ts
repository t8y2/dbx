export interface TabNavigationHistory {
  entries: string[];
  index: number;
}

export interface TabNavigationHistoryMove {
  history: TabNavigationHistory;
  tabId: string;
}

const MAX_TAB_NAVIGATION_HISTORY = 100;

export function createTabNavigationHistory(): TabNavigationHistory {
  return { entries: [], index: -1 };
}

export function recordTabVisit(history: TabNavigationHistory, tabId: string): TabNavigationHistory {
  if (!tabId || history.entries[history.index] === tabId) return history;

  const entries = [...history.entries.slice(0, history.index + 1), tabId].slice(-MAX_TAB_NAVIGATION_HISTORY);
  return { entries, index: entries.length - 1 };
}

export function moveInTabNavigationHistory(history: TabNavigationHistory, direction: -1 | 1, openTabIds: ReadonlySet<string>, currentTabId: string | null = null): TabNavigationHistoryMove | null {
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const tabId = history.entries[index];
    if (tabId !== currentTabId && openTabIds.has(tabId)) return { history: { entries: history.entries, index }, tabId };
  }
  return null;
}

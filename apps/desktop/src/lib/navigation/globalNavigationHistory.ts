import type { GlobalNavigationEntry } from "./navigationEntry";

export interface GlobalNavigationHistory {
  entries: GlobalNavigationEntry[];
  index: number;
}

export interface GlobalNavigationMove {
  history: GlobalNavigationHistory;
  entry: GlobalNavigationEntry;
}

export const MAX_GLOBAL_NAVIGATION_HISTORY = 100;

export function createGlobalNavigationHistory(): GlobalNavigationHistory {
  return { entries: [], index: -1 };
}

export function recordGlobalNavigation(history: GlobalNavigationHistory, entry: GlobalNavigationEntry): GlobalNavigationHistory {
  if (!entry.id) return history;
  const current = history.entries[history.index];
  if (current && current.id === entry.id) return history;
  const entries = [...history.entries.slice(0, history.index + 1), entry].slice(-MAX_GLOBAL_NAVIGATION_HISTORY);
  return { entries, index: entries.length - 1 };
}

export function moveGlobalNavigation(history: GlobalNavigationHistory, direction: -1 | 1, isValid: (entry: GlobalNavigationEntry) => boolean): GlobalNavigationMove | null {
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const entry = history.entries[index];
    if (entry && isValid(entry)) return { history: { entries: history.entries, index }, entry };
  }
  return null;
}

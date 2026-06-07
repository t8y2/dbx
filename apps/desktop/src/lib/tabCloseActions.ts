export interface TabLike {
  id: string;
}

export interface TabCloseState<T extends TabLike> {
  tabs: T[];
  activeTabId: string | null;
}

export function closeOtherTabsState<T extends TabLike>(
  tabs: readonly T[],
  activeTabId: string | null,
  targetTabId: string,
): TabCloseState<T> {
  const target = tabs.find((tab) => tab.id === targetTabId);
  if (!target) return { tabs: [...tabs], activeTabId };

  return { tabs: [target], activeTabId: target.id };
}

export function closeAllTabsState<T extends TabLike>(
  _tabs: readonly T[],
  _activeTabId: string | null,
): TabCloseState<T> {
  return { tabs: [], activeTabId: null };
}

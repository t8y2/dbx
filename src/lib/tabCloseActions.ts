export interface TabLike {
  id: string;
}

export interface TabCloseState<T extends TabLike> {
  tabs: T[];
  activeTabId: string | null;
}

function resolveActiveTabId<T extends TabLike>(
  nextTabs: readonly T[],
  activeTabId: string | null,
  targetTabId: string,
): string | null {
  if (activeTabId && nextTabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  return nextTabs.some((tab) => tab.id === targetTabId) ? targetTabId : (nextTabs[0]?.id ?? null);
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

export function closeLeftTabsState<T extends TabLike>(
  tabs: readonly T[],
  activeTabId: string | null,
  targetTabId: string,
): TabCloseState<T> {
  const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  if (targetIndex < 0) return { tabs: [...tabs], activeTabId };

  const nextTabs = tabs.slice(targetIndex);
  return {
    tabs: nextTabs,
    activeTabId: resolveActiveTabId(nextTabs, activeTabId, targetTabId),
  };
}

export function closeRightTabsState<T extends TabLike>(
  tabs: readonly T[],
  activeTabId: string | null,
  targetTabId: string,
): TabCloseState<T> {
  const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  if (targetIndex < 0) return { tabs: [...tabs], activeTabId };

  const nextTabs = tabs.slice(0, targetIndex + 1);
  return {
    tabs: nextTabs,
    activeTabId: resolveActiveTabId(nextTabs, activeTabId, targetTabId),
  };
}

export function closeAllTabsState<T extends TabLike>(
  _tabs: readonly T[],
  _activeTabId: string | null,
): TabCloseState<T> {
  return { tabs: [], activeTabId: null };
}

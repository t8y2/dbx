export function orderPinnedFirst<T>(items: T[], isPinned: (item: T) => boolean): T[] {
  const pinned: T[] = [];
  const unpinned: T[] = [];

  for (const item of items) {
    if (isPinned(item)) pinned.push(item);
    else unpinned.push(item);
  }

  return [...pinned, ...unpinned];
}

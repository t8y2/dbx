const readGrants = new Set<string>();
const pending = new Map<string, Promise<boolean>>();

export async function requestPluginClipboardReadGrant(pluginId: string, pluginName: string): Promise<boolean> {
  if (readGrants.has(pluginId)) return true;
  const existing = pending.get(pluginId);
  if (existing) return existing;
  const request = Promise.resolve().then(() => globalThis.confirm(`Allow plugin “${pluginName || pluginId}” to read text from the clipboard for this DBX session?`));
  pending.set(pluginId, request);
  try {
    const granted = await request;
    if (granted) readGrants.add(pluginId);
    return granted;
  } finally {
    pending.delete(pluginId);
  }
}

export function resetPluginClipboardReadGrantsForTests(): void {
  readGrants.clear();
  pending.clear();
}

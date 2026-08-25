function storageWarn(action: string, key: string, error: unknown) {
  console.warn(`[DBX][storage:${action}] ${key}`, error);
}

export function safeLocalStorageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch (error) {
    storageWarn("get", key, error);
    return null;
  }
}

export function safeLocalStorageSet(key: string, value: string): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch (error) {
    storageWarn("set", key, error);
    return false;
  }
}

export function safeLocalStorageRemove(key: string) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch (error) {
    storageWarn("remove", key, error);
  }
}

/** 枚举指定前缀的 localStorage key（快照式收集，枚举期间不读写）。 */
export function safeLocalStorageKeysWithPrefix(prefix: string): string[] {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return [];
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch (error) {
    storageWarn("keys", prefix, error);
    return [];
  }
}

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

export function safeLocalStorageKeys(): string[] {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return [];
    const keys: string[] = [];
    const len = storage.length;
    for (let i = 0; i < len; i++) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch (error) {
    storageWarn("keys", "", error);
    return [];
  }
}

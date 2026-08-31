import { beforeEach, describe, expect, it } from "vitest";
import { loadTimeoutInheritanceBackup, TIMEOUT_INHERITANCE_BACKUP_STORAGE_KEY } from "@/lib/connection/timeoutInheritanceBackup";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

describe("timeout inheritance backup", () => {
  beforeEach(() => localStorage.clear());

  it("preserves query timeouts up to one hour while connection timeouts remain capped at 300 seconds", () => {
    localStorage.setItem(
      TIMEOUT_INHERITANCE_BACKUP_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        globalConnectTimeoutSecs: 301,
        globalQueryTimeoutSecs: 3600,
        connectSnapshots: { connection: 301 },
        querySnapshots: { longQuery: 3600, tooLong: 3601, unlimited: 0 },
      }),
    );

    expect(loadTimeoutInheritanceBackup()).toEqual({
      version: 1,
      globalConnectTimeoutSecs: 300,
      globalQueryTimeoutSecs: 3600,
      connectSnapshots: { connection: 300 },
      querySnapshots: { longQuery: 3600, tooLong: 3600, unlimited: 0 },
    });
  });
});

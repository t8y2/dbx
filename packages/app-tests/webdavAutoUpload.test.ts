import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWebDavAutoUpload } from "@/composables/useWebDavAutoUpload";
import { readWebDavAutoUploadConfig } from "@/lib/webdav/webdavAutoUploadConfig";

const { webdavSyncUploadMock } = vi.hoisted(() => ({
  webdavSyncUploadMock: vi.fn(),
}));

vi.mock("vue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue")>();
  return {
    ...actual,
    onMounted: (hook: () => void) => hook(),
    onUnmounted: vi.fn(),
  };
});

vi.mock("@/lib/backend/api", () => ({
  webdavSyncUpload: webdavSyncUploadMock,
}));

function installLocalStorage() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

let restoreLocalStorage: (() => void) | undefined;
let restoreWindow: (() => void) | undefined;

function installWindow() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Map<string, Set<(event: Event) => void>>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      addEventListener: (type: string, listener: (event: Event) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event: Event) => {
        listeners.get(event.type)?.forEach((listener) => listener(event));
        return true;
      },
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  webdavSyncUploadMock.mockResolvedValue({ bytes: 42, remotePath: "DBX/sync/snapshot.json" });
  restoreLocalStorage = installLocalStorage();
  restoreWindow = installWindow();
  setActivePinia(createPinia());
});

afterEach(() => {
  restoreWindow?.();
  restoreWindow = undefined;
  restoreLocalStorage?.();
  restoreLocalStorage = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

test("reads normalized WebDAV auto-upload config from localStorage", () => {
  localStorage.setItem("dbx-webdav-endpoint", " https://dav.example.com/ ");
  localStorage.setItem("dbx-webdav-username", " alice ");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "0");

  const config = readWebDavAutoUploadConfig();

  assert.equal(config.enabled, true);
  assert.equal(config.intervalMinutes, 1);
  assert.deepEqual(config.webDavConfig, {
    endpoint: "https://dav.example.com/",
    username: "alice",
    remotePath: "DBX/sync/snapshot.json",
  });
});

test("keeps WebDAV auto-upload running outside the settings dialog", async () => {
  localStorage.setItem("dbx-webdav-endpoint", "https://dav.example.com/");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "1");

  useWebDavAutoUpload();

  await vi.advanceTimersByTimeAsync(60_000);

  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
  assert.deepEqual(webdavSyncUploadMock.mock.calls[0][0], {
    endpoint: "https://dav.example.com/",
    username: undefined,
    remotePath: "DBX/sync/snapshot.json",
  });

  localStorage.setItem("dbx-webdav-auto-upload-enabled", "false");
  window.dispatchEvent(new Event("dbx:webdav-auto-upload-config-changed"));
  await vi.advanceTimersByTimeAsync(60_000);

  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
});

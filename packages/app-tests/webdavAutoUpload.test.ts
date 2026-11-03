import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWebDavAutoUpload } from "@/composables/useWebDavAutoUpload";
import { readWebDavAutoUploadConfig, readWebDavLastUploadAt, writeWebDavLastUploadAt } from "@/lib/webdav/webdavAutoUploadConfig";

const { webdavSyncSecretsStatusMock, webdavSyncUploadMock } = vi.hoisted(() => ({
  webdavSyncSecretsStatusMock: vi.fn(),
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
  webdavSyncSecretsStatus: webdavSyncSecretsStatusMock,
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
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
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
  webdavSyncSecretsStatusMock.mockResolvedValue({ enabled: false, hasSavedPassphrase: false });
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
    userAgent: undefined,
  });
});

test("reads configured WebDAV user agent for client-restricted gateways", () => {
  localStorage.setItem("dbx-webdav-endpoint", "https://dav.example.com/");
  localStorage.setItem("dbx-webdav-user-agent", " Zotero/7.0.15 ");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "1");

  const config = readWebDavAutoUploadConfig();

  assert.equal(config.webDavConfig?.userAgent, "Zotero/7.0.15");

  useWebDavAutoUpload();

  return vi.advanceTimersByTimeAsync(60_000).then(() => {
    assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
    assert.equal(webdavSyncUploadMock.mock.calls[0][0].userAgent, "Zotero/7.0.15");
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
    userAgent: undefined,
  });
  assert.equal(webdavSyncUploadMock.mock.calls[0][3], false);

  localStorage.setItem("dbx-webdav-auto-upload-enabled", "false");
  window.dispatchEvent(new Event("dbx:webdav-auto-upload-config-changed"));
  await vi.advanceTimersByTimeAsync(60_000);

  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
});

test("triggers upload immediately on startup when last upload time is older than configured interval", async () => {
  localStorage.setItem("dbx-webdav-endpoint", "https://dav.example.com/");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "1440");

  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60_000;
  writeWebDavLastUploadAt(threeDaysAgo, false);

  useWebDavAutoUpload();

  assert.equal(webdavSyncUploadMock.mock.calls.length, 0);

  await vi.advanceTimersByTimeAsync(0);

  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
  const updatedLastUploadAt = readWebDavLastUploadAt();
  assert.ok(updatedLastUploadAt !== null && updatedLastUploadAt >= Date.now() - 1000);
});

test("schedules upload for the remaining duration when last upload was within interval", async () => {
  localStorage.setItem("dbx-webdav-endpoint", "https://dav.example.com/");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "1440");

  const tenHoursAgo = Date.now() - 10 * 60 * 60_000;
  writeWebDavLastUploadAt(tenHoursAgo, false);

  useWebDavAutoUpload();

  await vi.advanceTimersByTimeAsync(13 * 60 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 0);

  await vi.advanceTimersByTimeAsync(1 * 60 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
});

test("manual upload resets the auto-upload countdown", async () => {
  localStorage.setItem("dbx-webdav-endpoint", "https://dav.example.com/");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "60");

  useWebDavAutoUpload();

  await vi.advanceTimersByTimeAsync(30 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 0);

  writeWebDavLastUploadAt(Date.now());

  await vi.advanceTimersByTimeAsync(30 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 0);

  await vi.advanceTimersByTimeAsync(30 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
});

test("retries after backoff when auto-upload fails instead of infinite loop", async () => {
  webdavSyncUploadMock.mockRejectedValueOnce(new Error("Network offline"));
  localStorage.setItem("dbx-webdav-endpoint", "https://dav.example.com/");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "1440");

  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60_000;
  writeWebDavLastUploadAt(threeDaysAgo, false);

  useWebDavAutoUpload();

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);

  await vi.advanceTimersByTimeAsync(4 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);

  webdavSyncUploadMock.mockResolvedValueOnce({ bytes: 42, remotePath: "DBX/sync/snapshot.json" });
  await vi.advanceTimersByTimeAsync(1 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 2);
});

test("auto-upload in-flight switching target records old target success without overwriting new target schedule", async () => {
  const targetA = { endpoint: "https://dav.a.example.com/" };
  const targetB = { endpoint: "https://dav.b.example.com/" };

  localStorage.setItem("dbx-webdav-endpoint", targetA.endpoint);
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "60");

  let resolveUploadA!: (value: any) => void;
  webdavSyncUploadMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveUploadA = resolve;
      }),
  );

  useWebDavAutoUpload();

  // Advance timer to trigger Target A upload
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
  assert.equal(webdavSyncUploadMock.mock.calls[0][0].endpoint, targetA.endpoint);

  // While Target A upload is in flight, user switches target to Target B with 1440 min interval
  localStorage.setItem("dbx-webdav-endpoint", targetB.endpoint);
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "1440");
  window.dispatchEvent(new Event("dbx:webdav-auto-upload-config-changed"));

  const targetBBaseline = readWebDavLastUploadAt(targetB);
  assert.ok(targetBBaseline !== null);

  // Now Target A's upload completes
  const uploadCompletedAt = Date.now() + 10_000;
  vi.setSystemTime(uploadCompletedAt);
  resolveUploadA({ bytes: 100, remotePath: "DBX/sync/snapshot.json" });
  await vi.advanceTimersByTimeAsync(0);

  // Target A's last upload time was recorded for Target A
  assert.equal(readWebDavLastUploadAt(targetA), uploadCompletedAt);

  // Target B's last upload time was NOT overwritten by Target A's completion
  assert.equal(readWebDavLastUploadAt(targetB), targetBBaseline);

  // Target B must not have triggered prematurely
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
});

test("auto-upload in-flight disabling auto-upload prevents rescheduling", async () => {
  localStorage.setItem("dbx-webdav-endpoint", "https://dav.example.com/");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "60");

  let resolveUpload!: (value: any) => void;
  webdavSyncUploadMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
  );

  useWebDavAutoUpload();

  await vi.advanceTimersByTimeAsync(60 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);

  // Disable while upload is in progress
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "false");
  window.dispatchEvent(new Event("dbx:webdav-auto-upload-config-changed"));

  resolveUpload({ bytes: 42, remotePath: "DBX/sync/snapshot.json" });
  await vi.advanceTimersByTimeAsync(0);

  // Advancing time should not trigger any more uploads
  await vi.advanceTimersByTimeAsync(120 * 60_000);
  assert.equal(webdavSyncUploadMock.mock.calls.length, 1);
});

test("manual upload in-flight switching target preserves target isolation", async () => {
  const targetA = { endpoint: "https://dav.a.example.com/" };
  const targetB = { endpoint: "https://dav.b.example.com/" };

  localStorage.setItem("dbx-webdav-endpoint", targetA.endpoint);
  localStorage.setItem("dbx-webdav-auto-upload-enabled", "true");
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", "60");

  useWebDavAutoUpload();

  // Target A is configured
  writeWebDavLastUploadAt(targetA, 1_000, false);

  // User starts manual sync for Target A
  const uploadConfig = { ...targetA };
  // While manual upload is running, user switches settings to Target B
  localStorage.setItem("dbx-webdav-endpoint", targetB.endpoint);
  window.dispatchEvent(new Event("dbx:webdav-auto-upload-config-changed"));

  // Manual sync completes for Target A; checks whether targetA is still current
  const currentConfig = readWebDavAutoUploadConfig();
  const isCurrent = Boolean(currentConfig.enabled && currentConfig.webDavConfig && targetA.endpoint === currentConfig.webDavConfig.endpoint);
  assert.equal(isCurrent, false);

  const completionTime = Date.now() + 5000;
  writeWebDavLastUploadAt(uploadConfig, completionTime, isCurrent);

  // Target A has the updated timestamp
  assert.equal(readWebDavLastUploadAt(targetA), completionTime);
  // Target B does not have Target A's timestamp
  assert.notEqual(readWebDavLastUploadAt(targetB), completionTime);
});

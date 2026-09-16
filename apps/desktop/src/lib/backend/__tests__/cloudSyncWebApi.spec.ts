import { beforeEach, describe, expect, it, vi } from "vitest";

describe("WebDAV sync HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetch(response: unknown = undefined) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(response),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function lastCall(fetchMock: ReturnType<typeof stubFetch>): { url: string; body: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  const config = {
    endpoint: "https://dav.example.com/remote.php/dav/files/alice/",
    username: "alice",
    password: "app-password",
    remotePath: "DBX/sync/snapshot.json",
  };

  it("routes WebDAV connectivity and saved-password operations through the Web backend", async () => {
    const fetchMock = stubFetch({ hasSavedPassword: true });
    const { forgetWebdavSavedPassword, saveWebdavSavedPassword, webdavPasswordStatus, webdavSyncTest } = await import("@/lib/backend/http");

    await webdavSyncTest(config);
    expect(lastCall(fetchMock)).toEqual({ url: "/api/cloud-sync/webdav/test", body: { config } });

    await expect(webdavPasswordStatus(config)).resolves.toEqual({ hasSavedPassword: true });
    expect(lastCall(fetchMock)).toEqual({ url: "/api/cloud-sync/webdav/password-status", body: { config } });

    await saveWebdavSavedPassword(config, "saved-password");
    expect(lastCall(fetchMock)).toEqual({ url: "/api/cloud-sync/webdav/save-password", body: { config, password: "saved-password" } });

    await forgetWebdavSavedPassword(config);
    expect(lastCall(fetchMock)).toEqual({ url: "/api/cloud-sync/webdav/forget-password", body: { config } });
  });

  it("routes WebDAV secret preferences and snapshot transfers through the Web backend", async () => {
    const fetchMock = stubFetch({ bytes: 42, remotePath: config.remotePath });
    const { forgetWebdavSyncSecretsPassphrase, saveWebdavSyncSecretsPreference, webdavSyncDownload, webdavSyncSecretsStatus, webdavSyncUpload } = await import("@/lib/backend/http");

    await webdavSyncSecretsStatus();
    expect(lastCall(fetchMock)).toEqual({ url: "/api/cloud-sync/webdav/sync-secrets-status", body: {} });

    await saveWebdavSyncSecretsPreference(true, "sync-passphrase");
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/cloud-sync/webdav/save-sync-secrets-preference",
      body: { enabled: true, passphrase: "sync-passphrase" },
    });

    await forgetWebdavSyncSecretsPassphrase();
    expect(lastCall(fetchMock)).toEqual({ url: "/api/cloud-sync/webdav/forget-sync-secrets-passphrase", body: {} });

    const editorSettings = { theme: "dark" };
    await webdavSyncUpload(config, editorSettings, "sync-passphrase");
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/cloud-sync/webdav/upload",
      body: { config, editorSettings, secretsPassphrase: "sync-passphrase" },
    });

    await webdavSyncDownload(config, "sync-passphrase");
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/cloud-sync/webdav/download",
      body: { config, secretsPassphrase: "sync-passphrase" },
    });
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeSnippetRemoteContentHash } from "./snippetAutoUploadConfig";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue({ snippetId: "shared" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { snippetSyncUpload } from "../backend/tauri";

describe("manual snippet upload version guard", () => {
  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
    invoke.mockClear();
  });

  it("sends the last synchronized version rather than accepting the current remote version", async () => {
    writeSnippetRemoteContentHash("gitee", undefined, "shared", "a".repeat(64));
    await snippetSyncUpload({ provider: "gitee", snippetId: "shared" }, {}, "password", true, "secrets");
    expect(invoke).toHaveBeenCalledWith(
      "snippet_sync_upload",
      expect.objectContaining({
        expectedRemoteContentHash: "a".repeat(64),
        automatic: false,
        includeSecrets: true,
      }),
    );
  });

  it("does not reuse another provider, instance or snippet's version", async () => {
    writeSnippetRemoteContentHash("github", undefined, "shared", "a".repeat(64));
    writeSnippetRemoteContentHash("gitee", undefined, "other", "b".repeat(64));
    writeSnippetRemoteContentHash("gitlab", "https://one.example", "shared", "c".repeat(64));
    for (const config of [
      { provider: "gitee" as const, snippetId: "shared" },
      { provider: "gitlab" as const, instanceUrl: "https://two.example", snippetId: "shared" },
    ]) {
      await snippetSyncUpload(config);
      expect(invoke).toHaveBeenLastCalledWith("snippet_sync_upload", expect.objectContaining({ expectedRemoteContentHash: undefined, automatic: false }));
    }
  });

  it("preserves the explicit version and restrictions for automatic uploads", async () => {
    await snippetSyncUpload({ provider: "gitee", snippetId: "shared" }, undefined, undefined, false, undefined, undefined, "b".repeat(64), true);
    expect(invoke).toHaveBeenCalledWith("snippet_sync_upload", expect.objectContaining({ expectedRemoteContentHash: "b".repeat(64), automatic: true }));
  });

  it("leaves a new snippet without a baseline", async () => {
    await snippetSyncUpload({ provider: "gitee" });
    expect(invoke).toHaveBeenCalledWith("snippet_sync_upload", expect.objectContaining({ expectedRemoteContentHash: undefined }));
  });
});

// The Web bridge must carry the same guard even though the UI currently
// exposes snippet sync on Desktop only.
it("sends the saved version through the HTTP bridge", async () => {
  const { snippetSyncUpload: upload } = await import("../backend/http");
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ snippetId: "shared" }) });
  vi.stubGlobal("fetch", fetchMock);
  writeSnippetRemoteContentHash("gitee", undefined, "shared", "c".repeat(64));
  await upload({ provider: "gitee", snippetId: "shared" });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ expectedRemoteContentHash: "c".repeat(64), automatic: false });
});

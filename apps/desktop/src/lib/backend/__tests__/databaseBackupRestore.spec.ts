import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDatabaseBackupRestore, previewSqlFile, releaseSqlFilePreview } from "@/lib/backend/http";

afterEach(() => vi.unstubAllGlobals());

describe("Web backup restore transport", () => {
  it("returns the server preview from the record-authorized restore endpoint", async () => {
    const preview = { fileName: "backup.sql", filePath: "/server/tmp/sql_file/restore-token/backup.sql", preview: "SELECT 1;", cleanupToken: "restore-token" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => preview });
    vi.stubGlobal("fetch", fetchMock);
    await expect(prepareDatabaseBackupRestore("run/1", 2)).resolves.toEqual(preview);
    expect(fetchMock).toHaveBeenCalledWith("/api/database-backups/run%2F1/files/2/restore", expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("continues rejecting arbitrary server paths without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(previewSqlFile("/etc/passwd")).rejects.toThrow("requires a File object");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases only by the opaque cleanup token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => null });
    vi.stubGlobal("fetch", fetchMock);
    await releaseSqlFilePreview("restore-token");
    expect(fetchMock).toHaveBeenCalledWith("/api/sql-file/preview/release", expect.objectContaining({ method: "POST", body: '{"cleanupToken":"restore-token"}' }));
  });
});

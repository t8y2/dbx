import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import { inspectExternalSqlFile, readExternalSqlFile, readExternalSqlFileSnapshot, writeExternalSqlFile } from "@/lib/backend/tauri";

const version = {
  sizeBytes: 9,
  modifiedNs: "123000000",
  contentHash: "abc123",
};

describe("external SQL file API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("returns editor content from the structured backend response", async () => {
    mocks.invoke.mockResolvedValue({ kind: "content", content: "select 1;", version });

    await expect(readExternalSqlFile("/tmp/demo.sql")).resolves.toBe("select 1;");
    expect(mocks.invoke).toHaveBeenCalledWith("read_external_sql_file", { path: "/tmp/demo.sql" });
  });

  it("returns the disk version with an editor snapshot", async () => {
    mocks.invoke.mockResolvedValue({ kind: "content", content: "select 1;", version });

    await expect(readExternalSqlFileSnapshot("/tmp/demo.sql")).resolves.toEqual({ content: "select 1;", version });
  });

  it("inspects metadata without reading editor content", async () => {
    mocks.invoke.mockResolvedValue({ kind: "present", sizeBytes: 9, modifiedNs: "123000000" });

    await expect(inspectExternalSqlFile("/tmp/demo.sql")).resolves.toEqual({ kind: "present", sizeBytes: 9, modifiedNs: "123000000" });
    expect(mocks.invoke).toHaveBeenCalledWith("inspect_external_sql_file", { path: "/tmp/demo.sql" });
  });

  it("passes the expected version to checked writes", async () => {
    mocks.invoke.mockResolvedValue({ kind: "written", version });

    await expect(writeExternalSqlFile("/tmp/demo.sql", "select 2;", { expectedContentHash: "abc123" })).resolves.toEqual({ kind: "written", version });
    expect(mocks.invoke).toHaveBeenCalledWith("write_external_sql_file", {
      path: "/tmp/demo.sql",
      content: "select 2;",
      expectedContentHash: "abc123",
      expectedMissing: false,
    });
  });

  it("passes an expected-missing precondition to recreate writes", async () => {
    mocks.invoke.mockResolvedValue({ kind: "written", version });

    await expect(writeExternalSqlFile("/tmp/demo.sql", "select 2;", { expectedMissing: true })).resolves.toEqual({ kind: "written", version });
    expect(mocks.invoke).toHaveBeenCalledWith("write_external_sql_file", {
      path: "/tmp/demo.sql",
      content: "select 2;",
      expectedContentHash: null,
      expectedMissing: true,
    });
  });

  it("maps oversized responses to a typed frontend error", async () => {
    mocks.invoke.mockResolvedValue({ kind: "tooLarge", sizeBytes: 50 * 1024 ** 3, maxSizeBytes: 64 * 1024 ** 2 });

    const error = await readExternalSqlFile("/tmp/backup.sql").catch((reason) => reason);

    expect(error).toBeInstanceOf(ExternalSqlFileTooLargeError);
    expect(error).toMatchObject({ sizeBytes: 50 * 1024 ** 3, maxSizeBytes: 64 * 1024 ** 2 });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import { readExternalSqlFile } from "@/lib/backend/tauri";

describe("external SQL file API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("returns editor content from the structured backend response", async () => {
    mocks.invoke.mockResolvedValue({ kind: "content", content: "select 1;" });

    await expect(readExternalSqlFile("/tmp/demo.sql")).resolves.toBe("select 1;");
    expect(mocks.invoke).toHaveBeenCalledWith("read_external_sql_file", { path: "/tmp/demo.sql" });
  });

  it("maps oversized responses to a typed frontend error", async () => {
    mocks.invoke.mockResolvedValue({ kind: "tooLarge", sizeBytes: 50 * 1024 ** 3, maxSizeBytes: 64 * 1024 ** 2 });

    const error = await readExternalSqlFile("/tmp/backup.sql").catch((reason) => reason);

    expect(error).toBeInstanceOf(ExternalSqlFileTooLargeError);
    expect(error).toMatchObject({ sizeBytes: 50 * 1024 ** 3, maxSizeBytes: 64 * 1024 ** 2 });
  });
});

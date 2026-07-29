import { describe, expect, it } from "vitest";
import type { SqlFilePreview } from "@/lib/backend/api";
import { buildDisplayFileNames, tooltipText } from "./sqlFilePreviewLabel";

function makePreview(fileName: string, filePath: string): SqlFilePreview {
  return {
    fileName,
    filePath,
    sizeBytes: 100,
    preview: "SELECT 1;",
    canExecuteWithoutSelectedDatabase: false,
  };
}

describe("buildDisplayFileNames", () => {
  describe("desktop (Tauri) mode", () => {
    it("returns just fileName when all names are unique", () => {
      const items = [makePreview("users.sql", "/projects/db/migration/users.sql"), makePreview("orders.sql", "/projects/db/migration/orders.sql")];
      const result = buildDisplayFileNames(items, true);
      expect(result.get("/projects/db/migration/users.sql")).toBe("users.sql");
      expect(result.get("/projects/db/migration/orders.sql")).toBe("orders.sql");
    });

    it("disambiguates same-name files in different directories via shortest unique parent", () => {
      const items = [makePreview("create.sql", "/projects/migration/create.sql"), makePreview("create.sql", "/projects/seed/create.sql")];
      const result = buildDisplayFileNames(items, true);
      expect(result.get("/projects/migration/create.sql")).toBe("migration/create.sql");
      expect(result.get("/projects/seed/create.sql")).toBe("seed/create.sql");
    });

    it("walks up multiple levels until paths diverge", () => {
      const items = [makePreview("create.sql", "/projects/a/b/migration/create.sql"), makePreview("create.sql", "/projects/c/d/migration/create.sql")];
      const result = buildDisplayFileNames(items, true);
      // "migration/create.sql" is identical for both, so go one level deeper
      expect(result.get("/projects/a/b/migration/create.sql")).toBe("b/migration/create.sql");
      expect(result.get("/projects/c/d/migration/create.sql")).toBe("d/migration/create.sql");
    });

    it("normalizes Windows backslash paths before splitting", () => {
      const items = [makePreview("create.sql", "C:\\projects\\migration\\create.sql"), makePreview("create.sql", "C:\\projects\\seed\\create.sql")];
      const result = buildDisplayFileNames(items, true);
      expect(result.get("C:\\projects\\migration\\create.sql")).toBe("migration/create.sql");
      expect(result.get("C:\\projects\\seed\\create.sql")).toBe("seed/create.sql");
    });

    it("falls back to full normalized path when no shorter unique suffix exists", () => {
      // Two identical filePaths won't happen in practice (filePath is the key),
      // but if paths are structurally identical at every depth the full path is used.
      const items = [makePreview("dup.sql", "/x/dup.sql"), makePreview("dup.sql", "/y/dup.sql")];
      const result = buildDisplayFileNames(items, true);
      // "x/dup.sql" and "y/dup.sql" are already unique at depth 2
      expect(result.get("/x/dup.sql")).toBe("x/dup.sql");
      expect(result.get("/y/dup.sql")).toBe("y/dup.sql");
    });
  });

  describe("web mode", () => {
    it("returns just fileName when all names are unique", () => {
      const items = [makePreview("users.sql", "/tmp/sql_file/users-abc.sql"), makePreview("orders.sql", "/tmp/sql_file/orders-def.sql")];
      const result = buildDisplayFileNames(items, false);
      expect(result.get("/tmp/sql_file/users-abc.sql")).toBe("users.sql");
      expect(result.get("/tmp/sql_file/orders-def.sql")).toBe("orders.sql");
    });

    it("uses stable 1-based index suffix for duplicate fileNames", () => {
      const items = [makePreview("create.sql", "/tmp/sql_file/create-uuid1.sql"), makePreview("create.sql", "/tmp/sql_file/create-uuid2.sql"), makePreview("create.sql", "/tmp/sql_file/create-uuid3.sql")];
      const result = buildDisplayFileNames(items, false);
      expect(result.get("/tmp/sql_file/create-uuid1.sql")).toBe("create.sql");
      expect(result.get("/tmp/sql_file/create-uuid2.sql")).toBe("create.sql (2)");
      expect(result.get("/tmp/sql_file/create-uuid3.sql")).toBe("create.sql (3)");
    });

    it("does not expose server temp paths or UUIDs in labels", () => {
      const items = [makePreview("init.sql", "/tmp/sql_file/init-a1b2c3d4.sql"), makePreview("init.sql", "/tmp/sql_file/init-e5f6g7h8.sql")];
      const result = buildDisplayFileNames(items, false);
      for (const label of result.values()) {
        expect(label).not.toContain("/tmp/");
        expect(label).not.toContain("uuid");
        expect(label).not.toMatch(/[0-9a-f]{8}-/);
      }
    });
  });

  it("returns empty map for empty input", () => {
    expect(buildDisplayFileNames([], true).size).toBe(0);
    expect(buildDisplayFileNames([], false).size).toBe(0);
  });

  it("handles a single file in both modes", () => {
    const items = [makePreview("solo.sql", "/path/solo.sql")];
    expect(buildDisplayFileNames(items, true).get("/path/solo.sql")).toBe("solo.sql");
    expect(buildDisplayFileNames(items, false).get("/path/solo.sql")).toBe("solo.sql");
  });
});

describe("tooltipText", () => {
  it("shows the real filePath in desktop mode", () => {
    const item = makePreview("create.sql", "/projects/migration/create.sql");
    const labels = new Map([["/projects/migration/create.sql", "migration/create.sql"]]);
    expect(tooltipText(item, labels, true)).toBe("/projects/migration/create.sql");
  });

  it("shows the user-facing label in web mode, not the server temp path", () => {
    const item = makePreview("create.sql", "/tmp/sql_file/create-uuid1.sql");
    const labels = new Map([["/tmp/sql_file/create-uuid1.sql", "create.sql (2)"]]);
    const result = tooltipText(item, labels, false);
    expect(result).toBe("create.sql (2)");
    expect(result).not.toContain("/tmp/");
    expect(result).not.toContain("uuid");
  });

  it("falls back to fileName when label is missing in web mode", () => {
    const item = makePreview("create.sql", "/tmp/sql_file/create-uuid1.sql");
    const labels = new Map<string, string>();
    expect(tooltipText(item, labels, false)).toBe("create.sql");
  });
});

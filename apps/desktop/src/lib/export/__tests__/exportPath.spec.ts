// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLastExportDirectory, getLastExportDirectory, getParentDirectory, isAbsolutePath, joinExportPath, LAST_EXPORT_DIRECTORY_STORAGE_KEY, promptExportSavePath, rememberLastExportPath, resolveExportDefaultPath, setLastExportDirectory } from "../exportPath";

const mockSave = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (args: unknown) => mockSave(args),
}));

describe("exportPath", () => {
  beforeEach(() => {
    localStorage.clear();
    mockSave.mockReset();
  });

  describe("isAbsolutePath", () => {
    it("recognizes POSIX absolute paths", () => {
      expect(isAbsolutePath("/home/user/export.csv")).toBe(true);
      expect(isAbsolutePath("/export.csv")).toBe(true);
    });

    it("recognizes Windows absolute paths", () => {
      expect(isAbsolutePath("C:\\exports\\file.csv")).toBe(true);
      expect(isAbsolutePath("D:/exports/file.csv")).toBe(true);
      expect(isAbsolutePath("\\\\server\\share\\file.csv")).toBe(true);
    });

    it("recognizes relative paths", () => {
      expect(isAbsolutePath("export.csv")).toBe(false);
      expect(isAbsolutePath("exports/file.csv")).toBe(false);
      expect(isAbsolutePath("./file.csv")).toBe(false);
      expect(isAbsolutePath("")).toBe(false);
    });
  });

  describe("getParentDirectory", () => {
    it("extracts parent directory from POSIX paths", () => {
      expect(getParentDirectory("/home/user/exports/test.csv")).toBe("/home/user/exports");
      expect(getParentDirectory("/test.csv")).toBe("/");
    });

    it("extracts parent directory from Windows paths", () => {
      expect(getParentDirectory("C:\\Users\\John\\test.csv")).toBe("C:\\Users\\John");
      expect(getParentDirectory("C:\\test.csv")).toBe("C:\\");
      expect(getParentDirectory("C:/test.csv")).toBe("C:/");
      expect(getParentDirectory("D:/Users/John/test.csv")).toBe("D:/Users/John");
    });

    it("returns empty string when there is no directory component", () => {
      expect(getParentDirectory("test.csv")).toBe("");
      expect(getParentDirectory("")).toBe("");
    });
  });

  describe("joinExportPath", () => {
    it("joins directory and filename with appropriate separator", () => {
      expect(joinExportPath("/home/user", "test.csv")).toBe("/home/user/test.csv");
      expect(joinExportPath("/home/user/", "test.csv")).toBe("/home/user/test.csv");
      expect(joinExportPath("C:\\Users\\John", "test.csv")).toBe("C:\\Users\\John\\test.csv");
      expect(joinExportPath("C:\\Users\\John\\", "test.csv")).toBe("C:\\Users\\John\\test.csv");
    });

    it("returns filename when directory is empty", () => {
      expect(joinExportPath("", "test.csv")).toBe("test.csv");
      expect(joinExportPath("   ", "test.csv")).toBe("test.csv");
    });

    it("returns absolute filename unchanged", () => {
      expect(joinExportPath("/home/user", "/opt/test.csv")).toBe("/opt/test.csv");
      expect(joinExportPath("C:\\Users", "D:\\test.csv")).toBe("D:\\test.csv");
    });
  });

  describe("storage operations", () => {
    it("reads empty string when no directory is stored", () => {
      expect(getLastExportDirectory()).toBe("");
    });

    it("stores and retrieves last export directory", () => {
      setLastExportDirectory("/custom/export/dir");
      expect(getLastExportDirectory()).toBe("/custom/export/dir");
      expect(localStorage.getItem(LAST_EXPORT_DIRECTORY_STORAGE_KEY)).toBe("/custom/export/dir");
    });

    it("clears last export directory", () => {
      setLastExportDirectory("/custom/export/dir");
      clearLastExportDirectory();
      expect(getLastExportDirectory()).toBe("");
    });

    it("rememberLastExportPath stores directory of saved file", () => {
      rememberLastExportPath("/data/reports/monthly.csv");
      expect(getLastExportDirectory()).toBe("/data/reports");

      rememberLastExportPath("C:\\exports\\annual.xlsx");
      expect(getLastExportDirectory()).toBe("C:\\exports");
    });

    it("rememberLastExportPath ignores paths without directory or invalid inputs", () => {
      setLastExportDirectory("/initial/dir");
      rememberLastExportPath("plain-file.csv");
      expect(getLastExportDirectory()).toBe("/initial/dir");

      rememberLastExportPath(null);
      expect(getLastExportDirectory()).toBe("/initial/dir");

      rememberLastExportPath("");
      expect(getLastExportDirectory()).toBe("/initial/dir");
    });
  });

  describe("resolveExportDefaultPath", () => {
    it("returns filename unchanged if already absolute", () => {
      setLastExportDirectory("/last/dir");
      expect(resolveExportDefaultPath("/already/absolute.csv", { preferredPath: "/preferred/dir" })).toBe("/already/absolute.csv");
    });

    it("prefers preferredPath when provided", () => {
      setLastExportDirectory("/last/dir");
      expect(resolveExportDefaultPath("output.csv", { preferredPath: "/preferred/dir" })).toBe("/preferred/dir/output.csv");
    });

    it("falls back to last export directory when preferredPath is not set", () => {
      setLastExportDirectory("/last/dir");
      expect(resolveExportDefaultPath("output.csv")).toBe("/last/dir/output.csv");
      expect(resolveExportDefaultPath("output.csv", { preferredPath: "" })).toBe("/last/dir/output.csv");
      expect(resolveExportDefaultPath("output.csv", { preferredPath: "   " })).toBe("/last/dir/output.csv");
    });

    it("falls back to plain filename when neither preferred nor last directory is set", () => {
      expect(resolveExportDefaultPath("output.csv")).toBe("output.csv");
      expect(resolveExportDefaultPath("output.csv", { preferredPath: "" })).toBe("output.csv");
    });
  });

  describe("promptExportSavePath", () => {
    it("resolves defaultPath, opens dialog, and remembers chosen path", async () => {
      mockSave.mockResolvedValue("/saved/directory/report.csv");
      const result = await promptExportSavePath({
        defaultFileName: "report.csv",
        preferredPath: "/preferred/path",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });

      expect(mockSave).toHaveBeenCalledWith({
        defaultPath: "/preferred/path/report.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      expect(result).toBe("/saved/directory/report.csv");
      expect(getLastExportDirectory()).toBe("/saved/directory");
    });

    it("does not update last export directory when user cancels", async () => {
      setLastExportDirectory("/existing/dir");
      mockSave.mockResolvedValue(null);

      const result = await promptExportSavePath({
        defaultFileName: "report.csv",
      });

      expect(result).toBeNull();
      expect(getLastExportDirectory()).toBe("/existing/dir");
    });
  });
});

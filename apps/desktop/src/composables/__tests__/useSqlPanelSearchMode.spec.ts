// @vitest-environment happy-dom
import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSqlPanelSearchMode } from "../useSqlPanelSearchMode";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("SQL panel search preferences", () => {
  it.each([null, "invalid", "name", "content"])("restores and validates %s", (stored) => {
    if (stored !== null) localStorage.setItem("dbx-sql-library-search-mode", stored);
    const scope = effectScope();
    try {
      const mode = scope.run(() => useSqlPanelSearchMode("library"))!;
      expect(mode.value).toBe(stored === "content" ? "content" : "name");
      mode.value = "content";
      expect(localStorage.getItem("dbx-sql-library-search-mode")).toBe("content");
    } finally {
      scope.stop();
    }
  });

  it("remains usable if browser storage cannot be read or written", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scope = effectScope();
    try {
      const mode = scope.run(() => useSqlPanelSearchMode("file"))!;
      expect(mode.value).toBe("name");
      mode.value = "content";
      expect(mode.value).toBe("content");
    } finally {
      scope.stop();
    }
  });
});

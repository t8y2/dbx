import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSavedSqlEditorPosition, forgetSavedSqlEditorPosition, restoreSavedSqlEditorPosition, saveSavedSqlEditorPosition, SAVED_SQL_EDITOR_POSITIONS_STORAGE_KEY } from "../app/savedSqlEditorPosition";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

describe("savedSqlEditorPosition", () => {
  it("restores the saved cursor and viewport when the file is unchanged", () => {
    const sql = "select 1;\n\nselect 2;\n";
    const head = sql.indexOf("select 2");

    saveSavedSqlEditorPosition(
      createSavedSqlEditorPosition({
        savedSqlId: "file-a",
        sql,
        selection: { anchor: head, head },
        viewport: { scrollTop: 320, scrollLeft: 12 },
        now: 1,
      }),
    );

    expect(restoreSavedSqlEditorPosition("file-a", sql)).toEqual({
      selection: { anchor: head, head },
      viewport: { scrollTop: 320, scrollLeft: 12 },
    });
  });

  it("relocates the cursor by nearby SQL text when content is inserted before it", () => {
    const sql = "select 1;\n\nselect 2;\n";
    const head = sql.indexOf("select 2");
    const nextSql = "-- inserted header\n" + sql;

    saveSavedSqlEditorPosition(
      createSavedSqlEditorPosition({
        savedSqlId: "file-b",
        sql,
        selection: { anchor: head, head },
        viewport: { scrollTop: 320, scrollLeft: 12 },
        now: 1,
      }),
    );

    expect(restoreSavedSqlEditorPosition("file-b", nextSql)).toEqual({
      selection: { anchor: nextSql.indexOf("select 2"), head: nextSql.indexOf("select 2") },
      viewport: undefined,
    });
  });

  it("falls back to a safe offset when the previous context no longer exists", () => {
    const sql = "select 1;\n\nselect 2;\n";
    const head = sql.indexOf("select 2");

    saveSavedSqlEditorPosition(
      createSavedSqlEditorPosition({
        savedSqlId: "file-c",
        sql,
        selection: { anchor: head, head },
        now: 1,
      }),
    );

    const restored = restoreSavedSqlEditorPosition("file-c", "select 1;");

    expect(restored.selection).toEqual({ anchor: "select 1;".length, head: "select 1;".length });
    expect(restored.viewport).toBeUndefined();
  });

  it("forgets a deleted saved SQL file position", () => {
    saveSavedSqlEditorPosition(
      createSavedSqlEditorPosition({
        savedSqlId: "file-d",
        sql: "select 1;",
        selection: { anchor: 3, head: 3 },
        now: 1,
      }),
    );

    forgetSavedSqlEditorPosition("file-d");

    expect(restoreSavedSqlEditorPosition("file-d", "select 1;")).toEqual({});
  });

  it("keeps only the most recent saved SQL file positions", () => {
    for (let index = 0; index < 205; index += 1) {
      saveSavedSqlEditorPosition(
        createSavedSqlEditorPosition({
          savedSqlId: `file-${index}`,
          sql: "select 1;",
          selection: { anchor: 0, head: 0 },
          now: index,
        }),
      );
    }

    const stored = JSON.parse(storage.get(SAVED_SQL_EDITOR_POSITIONS_STORAGE_KEY) ?? "[]") as Array<{ savedSqlId: string }>;

    expect(stored).toHaveLength(200);
    expect(stored.some((item) => item.savedSqlId === "file-0")).toBe(false);
    expect(stored[0]?.savedSqlId).toBe("file-204");
  });
});

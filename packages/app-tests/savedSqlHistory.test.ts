import assert from "node:assert/strict";
import { test } from "vitest";
import { rankSavedSqlHistory, savedSqlHistoryScore, savedSqlMatchesHistoryScope } from "../../apps/desktop/src/lib/savedSqlHistory.ts";
import type { SavedSqlFile } from "../../apps/desktop/src/types/database.ts";

function file(input: Partial<SavedSqlFile> & Pick<SavedSqlFile, "id" | "name" | "connectionId" | "database">): SavedSqlFile {
  return {
    folderId: undefined,
    schema: undefined,
    sql: "select 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

test("SQL 库历史按连接和数据库过滤", () => {
  const files = [file({ id: "a", name: "a.sql", connectionId: "conn-1", database: "app" }), file({ id: "b", name: "b.sql", connectionId: "conn-1", database: "analytics" }), file({ id: "c", name: "c.sql", connectionId: "conn-2", database: "app" })];

  assert.deepEqual(
    rankSavedSqlHistory(files, {
      connectionId: "conn-1",
      database: "app",
    }).map((item) => item.id),
    ["a"],
  );
  assert.equal(savedSqlMatchesHistoryScope(files[2], { connectionId: "conn-1" }), false);
});

test("SQL 库历史综合打开次数和最近打开时间排序", () => {
  const now = Date.parse("2026-06-11T12:00:00.000Z");
  const files = [
    file({ id: "recent", name: "recent.sql", connectionId: "conn", database: "app", openCount: 2, openedAt: "2026-06-11T11:00:00.000Z" }),
    file({ id: "frequent", name: "frequent.sql", connectionId: "conn", database: "app", openCount: 7, openedAt: "2026-04-01T00:00:00.000Z" }),
    file({ id: "unused", name: "unused.sql", connectionId: "conn", database: "app", openCount: 0 }),
  ];

  assert.deepEqual(
    rankSavedSqlHistory(files, { now }).map((item) => item.id),
    ["frequent", "recent", "unused"],
  );
  assert.ok(savedSqlHistoryScore(files[0], now) > savedSqlHistoryScore(files[2], now));
});

test("表级入口会优先展示命中表名的 SQL", () => {
  const now = Date.parse("2026-06-11T12:00:00.000Z");
  const files = [
    file({ id: "generic", name: "daily.sql", connectionId: "conn", database: "app", openCount: 1, openedAt: "2026-06-11T11:00:00.000Z" }),
    file({ id: "orders", name: "orders-report.sql", connectionId: "conn", database: "app", sql: "select * from public.orders", openCount: 1, openedAt: "2026-06-11T10:00:00.000Z" }),
  ];

  assert.deepEqual(
    rankSavedSqlHistory(files, { connectionId: "conn", database: "app", schema: "public", tableName: "orders", now }).map((item) => item.id),
    ["orders", "generic"],
  );
});

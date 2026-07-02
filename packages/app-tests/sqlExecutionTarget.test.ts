import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  findStatementAtCursor: vi.fn(),
}));

vi.mock("@/lib/api", () => apiMock);

const { resolveExecutableSqlWithBackend } = await import("../../apps/desktop/src/lib/sqlExecutionTarget.ts");

beforeEach(() => {
  apiMock.findStatementAtCursor.mockReset();
});

test("mongodb backend resolution keeps the full text when nothing is selected", async () => {
  apiMock.findStatementAtCursor.mockResolvedValue("db.users.insertOne({ name: 'ignored' })");

  const fullSql = "db.users.insertOne({ name: 'Ada' });\ndb.users.insertOne({ name: 'Grace' });";
  const resolved = await resolveExecutableSqlWithBackend(fullSql, "", {
    mode: "current",
    cursorPos: fullSql.indexOf("Grace"),
    databaseType: "mongodb",
  });

  assert.equal(resolved, fullSql);
  assert.equal(apiMock.findStatementAtCursor.mock.calls.length, 0);
});

test("non-mongodb backend resolution still asks the backend for the current statement", async () => {
  apiMock.findStatementAtCursor.mockResolvedValue("SELECT 2");

  const fullSql = "SELECT 1;\nSELECT 2;";
  const resolved = await resolveExecutableSqlWithBackend(fullSql, "", {
    mode: "current",
    cursorPos: fullSql.indexOf("2"),
    databaseType: "postgres",
  });

  assert.equal(resolved, "SELECT 2");
  assert.deepEqual(apiMock.findStatementAtCursor.mock.calls[0], [fullSql, fullSql.indexOf("2"), "postgres"]);
});

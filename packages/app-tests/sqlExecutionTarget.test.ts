import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  findStatementAtCursor: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

const { resolveExecutableSqlWithBackend } = await import("../../apps/desktop/src/lib/sql/sqlExecutionTarget.ts");

beforeEach(() => {
  apiMock.findStatementAtCursor.mockReset();
});

test("mongodb backend resolution uses the current command when configured", async () => {
  apiMock.findStatementAtCursor.mockResolvedValue("db.users.insertOne({ name: 'ignored' })");

  const fullSql = 'db.users.find({ name: "Ada" });\ndb.users.find({ name: "Grace" });\ndb.users.find({ name: "Linus" });';
  const resolved = await resolveExecutableSqlWithBackend(fullSql, "", {
    mode: "current",
    cursorPos: fullSql.indexOf("Grace"),
    databaseType: "mongodb",
  });

  assert.equal(resolved, 'db.users.find({ name: "Grace" })');
  assert.equal(apiMock.findStatementAtCursor.mock.calls.length, 0);
});

test("mongodb backend resolution keeps the full text in all mode", async () => {
  const fullSql = 'db.users.find({ name: "Ada" });\ndb.users.find({ name: "Grace" });';
  const resolved = await resolveExecutableSqlWithBackend(fullSql, "", {
    mode: "all",
    cursorPos: fullSql.indexOf("Grace"),
    databaseType: "mongodb",
  });

  assert.equal(resolved, fullSql);
  assert.equal(apiMock.findStatementAtCursor.mock.calls.length, 0);
});

test("mongodb backend resolution prefers the manual selection", async () => {
  const fullSql = 'db.users.find({ name: "Ada" });\ndb.users.find({ name: "Grace" });';
  const selectedSql = 'db.users.find({ name: "Ada" })';
  const resolved = await resolveExecutableSqlWithBackend(fullSql, selectedSql, {
    mode: "current",
    cursorPos: fullSql.indexOf("Grace"),
    databaseType: "mongodb",
  });

  assert.equal(resolved, selectedSql);
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

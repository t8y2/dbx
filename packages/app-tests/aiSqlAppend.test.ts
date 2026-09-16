import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildAppendedEditorSql, buildDeduplicatedAppendedEditorSql } from "../../apps/desktop/src/lib/ai/aiSqlAppend.ts";

test("buildAppendedEditorSql returns newSql unchanged when editor is empty", () => {
  assert.equal(buildAppendedEditorSql("", "SELECT 1"), "SELECT 1");
});

test("buildAppendedEditorSql prepends blank-line separator when editor has content", () => {
  assert.equal(buildAppendedEditorSql("SELECT 1", "SELECT 2"), "SELECT 1\n\nSELECT 2");
});

test("buildAppendedEditorSql preserves multiline existing content", () => {
  assert.equal(buildAppendedEditorSql("SELECT *\nFROM users", "SELECT *\nFROM orders"), "SELECT *\nFROM users\n\nSELECT *\nFROM orders");
});

test("buildAppendedEditorSql preserves trailing newlines already present in the editor", () => {
  assert.equal(buildAppendedEditorSql("SELECT 1\n\n\n", "SELECT 2"), "SELECT 1\n\n\nSELECT 2");
});

test("buildAppendedEditorSql preserves trailing spaces", () => {
  assert.equal(buildAppendedEditorSql("SELECT 1   ", "SELECT 2"), "SELECT 1   \n\nSELECT 2");
});

test("buildAppendedEditorSql preserves trailing tabs", () => {
  assert.equal(buildAppendedEditorSql("SELECT 1\t\t", "SELECT 2"), "SELECT 1\t\t\n\nSELECT 2");
});

test("buildAppendedEditorSql preserves whitespace-only editor content", () => {
  assert.equal(buildAppendedEditorSql(" \t ", "SELECT 2"), " \t \n\nSELECT 2");
});

test("buildAppendedEditorSql preserves unfinished SQL", () => {
  assert.equal(buildAppendedEditorSql("SELECT * FROM", "SELECT * FROM users"), "SELECT * FROM\n\nSELECT * FROM users");
});

test("buildDeduplicatedAppendedEditorSql does not append when the editor exactly matches", () => {
  assert.equal(buildDeduplicatedAppendedEditorSql("SELECT 1", "SELECT 1"), "SELECT 1");
});

test("buildDeduplicatedAppendedEditorSql does not append a previously appended SQL block", () => {
  const editorSql = "SELECT 1\n\nSELECT 2";
  assert.equal(buildDeduplicatedAppendedEditorSql(editorSql, "SELECT 2"), editorSql);
});

test("buildDeduplicatedAppendedEditorSql detects a matching block in the middle", () => {
  const editorSql = "SELECT 1\n\nSELECT 2\n\nSELECT 3";
  assert.equal(buildDeduplicatedAppendedEditorSql(editorSql, "SELECT 2"), editorSql);
});

test("buildDeduplicatedAppendedEditorSql supports CRLF block separators", () => {
  const editorSql = "SELECT 1\r\n\r\nSELECT 2";
  assert.equal(buildDeduplicatedAppendedEditorSql(editorSql, "SELECT 2"), editorSql);
});

test("buildDeduplicatedAppendedEditorSql does not confuse a matching statement fragment with a standalone block", () => {
  assert.equal(buildDeduplicatedAppendedEditorSql("WITH value AS (\nSELECT 1\n)", "SELECT 1"), "WITH value AS (\nSELECT 1\n)\n\nSELECT 1");
});

test("buildDeduplicatedAppendedEditorSql appends SQL that is only a substring of an existing block", () => {
  assert.equal(buildDeduplicatedAppendedEditorSql("SELECT 10", "SELECT 1"), "SELECT 10\n\nSELECT 1");
});

test("buildDeduplicatedAppendedEditorSql ignores an empty append", () => {
  assert.equal(buildDeduplicatedAppendedEditorSql("SELECT 1", ""), "SELECT 1");
});

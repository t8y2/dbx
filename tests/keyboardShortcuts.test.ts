import { strict as assert } from "node:assert";
import test from "node:test";
import { isCloseTabShortcut, isExecuteSqlShortcut } from "../src/lib/keyboardShortcuts.ts";

test("matches Cmd+Enter for SQL execution", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter", metaKey: true }), true);
});

test("matches Ctrl+Enter for SQL execution", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter", ctrlKey: true }), true);
});

test("ignores Enter without modifier", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter" }), false);
});

test("ignores composing input events", () => {
  assert.equal(isExecuteSqlShortcut({ key: "Enter", metaKey: true, isComposing: true }), false);
});

test("matches Cmd+W for closing query tabs", () => {
  assert.equal(isCloseTabShortcut({ key: "w", metaKey: true }), true);
});

test("ignores Ctrl+W for closing query tabs", () => {
  assert.equal(isCloseTabShortcut({ key: "w", ctrlKey: true }), false);
});

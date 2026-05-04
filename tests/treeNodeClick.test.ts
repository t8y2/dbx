import test from "node:test";
import assert from "node:assert/strict";
import { treeNodeRowAction } from "../src/lib/treeNodeClick.ts";

test("table and view rows open data without toggling structure groups", () => {
  assert.equal(treeNodeRowAction("table", true), "open-data");
  assert.equal(treeNodeRowAction("view", true), "open-data");
});

test("expandable non-table rows still toggle from row clicks", () => {
  assert.equal(treeNodeRowAction("connection", true), "toggle");
  assert.equal(treeNodeRowAction("database", true), "toggle");
  assert.equal(treeNodeRowAction("schema", true), "toggle");
  assert.equal(treeNodeRowAction("group-columns", true), "toggle");
});

test("leaf data browser nodes keep their open behavior through toggle handler", () => {
  assert.equal(treeNodeRowAction("redis-db", false), "toggle");
  assert.equal(treeNodeRowAction("mongo-collection", false), "toggle");
});

test("plain metadata leaf rows do nothing on row clicks", () => {
  assert.equal(treeNodeRowAction("column", false), "none");
  assert.equal(treeNodeRowAction("index", false), "none");
});

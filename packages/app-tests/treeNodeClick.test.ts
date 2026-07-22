import { test } from "vitest";
import assert from "node:assert/strict";
import { copyNameForTreeNode, isDocumentBrowserTreeNode, objectSourceKindForTreeNode, shouldRunTreeNodeRowAction, sidebarSelectionCopyAction, treeNodeRowAction, treeNodeRowDoubleClickAction } from "../../apps/desktop/src/lib/sidebar/treeNodeClick.ts";

test("table and view rows open data without toggling structure groups", () => {
  assert.equal(treeNodeRowAction("table", true), "open-data");
  assert.equal(treeNodeRowAction("view", true), "open-data");
});

test("double click navigation mode selects rows on single click", () => {
  assert.equal(treeNodeRowAction("table", true, "double"), "none");
  assert.equal(treeNodeRowAction("view", true, "double"), "none");
  assert.equal(treeNodeRowAction("procedure", false, "double"), "none");
  assert.equal(treeNodeRowAction("saved-sql-file", false, "double"), "none");
});

test("table double click avoids a second action in single activation mode", () => {
  assert.equal(treeNodeRowDoubleClickAction("table", true, "single"), "none");
});

test("table double click activates data in double activation mode", () => {
  assert.equal(treeNodeRowDoubleClickAction("table", true, "double"), "activate-data");
});

test("double click navigation mode opens other actionable rows on double click", () => {
  assert.equal(treeNodeRowDoubleClickAction("view", true, "double"), "open-data");
  assert.equal(treeNodeRowDoubleClickAction("materialized_view", true, "double"), "open-data");
  assert.equal(treeNodeRowDoubleClickAction("procedure", false, "double"), "open-source");
  assert.equal(treeNodeRowDoubleClickAction("saved-sql-file", false, "double"), "open-saved-sql");
});

test("double click navigation mode toggles expandable rows on double click", () => {
  assert.equal(treeNodeRowDoubleClickAction("connection", false, "double", true), "toggle");
  assert.equal(treeNodeRowDoubleClickAction("group-columns", false, "double", true), "toggle");
  assert.equal(treeNodeRowDoubleClickAction("redis-db", false, "double", false), "toggle");
  assert.equal(treeNodeRowDoubleClickAction("etcd-root", false, "double", false), "toggle");
  assert.equal(treeNodeRowDoubleClickAction("zookeeper-root", false, "double", false), "toggle");
});

test("expandable non-table rows still toggle from row clicks", () => {
  assert.equal(treeNodeRowAction("connection", true), "toggle");
  assert.equal(treeNodeRowAction("database", true), "toggle");
  assert.equal(treeNodeRowAction("schema", true), "toggle");
  assert.equal(treeNodeRowAction("group-columns", true), "toggle");
});

test("leaf data browser nodes keep their open behavior through toggle handler", () => {
  assert.equal(treeNodeRowAction("redis-db", false), "toggle");
  assert.equal(treeNodeRowAction("etcd-root", false), "toggle");
  assert.equal(treeNodeRowAction("zookeeper-root", false), "toggle");
  assert.equal(treeNodeRowAction("mongo-gridfs" as never, false), "toggle");
  assert.equal(treeNodeRowAction("mongo-collection", false), "toggle");
  assert.equal(treeNodeRowAction("mongo-bucket", false), "toggle");
});

test("document browser helper covers Mongo collections and GridFS buckets", () => {
  assert.equal(isDocumentBrowserTreeNode("mongo-collection"), true);
  assert.equal(isDocumentBrowserTreeNode("mongo-bucket"), true);
  assert.equal(isDocumentBrowserTreeNode("redis-db"), false);
});

test("double-click follow-up clicks do not run row actions", () => {
  assert.equal(shouldRunTreeNodeRowAction("toggle", 1), true);
  assert.equal(shouldRunTreeNodeRowAction("toggle", 2), false);
  assert.equal(shouldRunTreeNodeRowAction("toggle", 3), false);
  assert.equal(shouldRunTreeNodeRowAction("open-data", 1), true);
  assert.equal(shouldRunTreeNodeRowAction("open-data", 2), false);
  assert.equal(shouldRunTreeNodeRowAction("none", 1), false);
});

test("plain metadata leaf rows do nothing on row clicks", () => {
  assert.equal(treeNodeRowAction("column", false), "none");
  assert.equal(treeNodeRowAction("index", false), "none");
});

test("maps source-capable sidebar nodes to object source kinds", () => {
  assert.equal(objectSourceKindForTreeNode("view"), "VIEW");
  assert.equal(objectSourceKindForTreeNode("procedure"), "PROCEDURE");
  assert.equal(objectSourceKindForTreeNode("function"), "FUNCTION");
  assert.equal(objectSourceKindForTreeNode("sequence"), "SEQUENCE");
  assert.equal(objectSourceKindForTreeNode("package"), "PACKAGE");
  assert.equal(objectSourceKindForTreeNode("package-body"), "PACKAGE_BODY");
  assert.equal(objectSourceKindForTreeNode("table"), null);
});

test("database and schema rows open object browser only on double click", () => {
  assert.equal(treeNodeRowAction("database", true), "toggle");
  assert.equal(treeNodeRowAction("schema", true), "toggle");
  assert.equal(treeNodeRowDoubleClickAction("database", true), "open-object-browser");
  assert.equal(treeNodeRowDoubleClickAction("schema", true), "open-object-browser");
  assert.equal(treeNodeRowAction("database", true, "double"), "none");
  assert.equal(treeNodeRowAction("schema", true, "double"), "none");
});

test("double click navigation mode opens object browser for database and schema rows", () => {
  assert.equal(treeNodeRowDoubleClickAction("database", true, "double", false), "open-object-browser");
  assert.equal(treeNodeRowDoubleClickAction("schema", true, "double", false), "open-object-browser");
});

test("double click navigation mode opens object browser and expands expandable database and schema rows", () => {
  assert.equal(treeNodeRowDoubleClickAction("database", true, "double", true), "open-object-browser-and-expand");
  assert.equal(treeNodeRowDoubleClickAction("schema", true, "double", true), "open-object-browser-and-expand");
});

test("double click does not open object browser for non-browsable rows", () => {
  assert.equal(treeNodeRowDoubleClickAction("database", false), "none");
  assert.equal(treeNodeRowDoubleClickAction("view", true), "none");
  assert.equal(treeNodeRowDoubleClickAction("materialized_view", true), "none");
  assert.equal(treeNodeRowDoubleClickAction("column", true), "none");
});

test("double click navigation mode copies the selected sidebar row name", () => {
  assert.equal(sidebarSelectionCopyAction({ key: "c", metaKey: true }), "copy-name");
  assert.equal(sidebarSelectionCopyAction({ key: "C", ctrlKey: true }), "copy-name");
});

test("single click navigation mode copies the selected sidebar row name", () => {
  assert.equal(sidebarSelectionCopyAction({ key: "c", metaKey: true }), "copy-name");
  assert.equal(sidebarSelectionCopyAction({ key: "C", ctrlKey: true }), "copy-name");
});

test("copying table child group rows uses the parent table name", () => {
  assert.equal(
    copyNameForTreeNode({
      id: "conn:db:public:orders:__columns",
      label: "tree.columns",
      type: "group-columns",
      tableName: "orders",
    }),
    "orders",
  );
  assert.equal(
    copyNameForTreeNode({
      id: "conn:db:public:orders:__indexes",
      label: "tree.indexes",
      type: "group-indexes",
      tableName: "orders",
    }),
    "orders",
  );
});

test("copying database object group rows uses the parent schema or database name", () => {
  assert.equal(
    copyNameForTreeNode({
      id: "conn:db:public:__tables",
      label: "tree.tables",
      type: "group-tables",
      database: "db",
      schema: "public",
    }),
    "public",
  );
  assert.equal(
    copyNameForTreeNode({
      id: "conn:db:__views",
      label: "tree.views",
      type: "group-views",
      database: "db",
    }),
    "db",
  );
});

test("copying column rows uses the column name without type suffix", () => {
  assert.equal(
    copyNameForTreeNode({
      id: "conn:db:public:orders:__columns:status",
      label: "status (varchar)",
      type: "column",
      meta: {
        name: "status",
        data_type: "varchar",
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        extra: null,
        comment: null,
        numeric_precision: null,
        numeric_scale: null,
        character_maximum_length: null,
      },
    }),
    "status",
  );
  assert.equal(
    copyNameForTreeNode({
      id: "conn:db:public:orders:__columns:status",
      label: "status (varchar)",
      type: "column",
    }),
    "status",
  );
});

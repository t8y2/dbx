import assert from "node:assert/strict";
import test from "node:test";
import { buildTableTreeNodes, expandCachedObjectBrowserNodes } from "../src/lib/tableTree.ts";
import type { TableInfo } from "../src/types/database.ts";

function table(name: string, tableType: "TABLE" | "VIEW" = "TABLE"): TableInfo {
  return { name, table_type: tableType };
}

test("keeps every table as a sidebar node instead of truncating to object browser", () => {
  const tables: TableInfo[] = Array.from({ length: 16 }, (_, index) => table(`table_${index + 1}`));

  const nodes = buildTableTreeNodes({
    nodeId: "conn:db",
    connectionId: "conn",
    database: "db",
    tables,
  });

  assert.equal(nodes.length, 16);
  assert.equal(nodes.at(-1)?.label, "table_16");
  assert.equal(
    nodes.some((node) => node.type === "object-browser"),
    false,
  );
});

test("preserves table and view node types", () => {
  const nodes = buildTableTreeNodes({
    nodeId: "conn:db:public",
    connectionId: "conn",
    database: "db",
    schema: "public",
    tables: [table("users"), table("user_view", "VIEW")],
  });

  assert.deepEqual(
    nodes.map((node) => [node.label, node.type, node.schema]),
    [
      ["users", "table", "public"],
      ["user_view", "view", "public"],
    ],
  );
});

test("expands cached object-browser nodes back into regular table nodes", () => {
  const nodes = expandCachedObjectBrowserNodes([
    {
      id: "conn:db:table_1",
      label: "table_1",
      type: "table",
      connectionId: "conn",
      database: "db",
      isExpanded: false,
      children: [],
    },
    {
      id: "conn:db:__object_browser",
      label: "tree.objectBrowser",
      type: "object-browser",
      connectionId: "conn",
      database: "db",
      hiddenChildren: [
        {
          id: "conn:db:table_16",
          label: "table_16",
          type: "table",
          connectionId: "conn",
          database: "db",
          isExpanded: false,
          children: [],
        },
      ],
    },
  ]);

  assert.deepEqual(
    nodes.map((node) => [node.label, node.type]),
    [
      ["table_1", "table"],
      ["table_16", "table"],
    ],
  );
});

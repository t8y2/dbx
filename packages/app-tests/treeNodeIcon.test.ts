import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { getTreeNodeIconInfo } from "../../apps/desktop/src/lib/sidebar/treeNodeIcon.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

const treeItemSource = readFileSync(new URL("../../apps/desktop/src/components/sidebar/TreeItem.vue", import.meta.url), "utf8");

function treeItemIconColorClass(nodeType: "schema" | "table", iconName: "FolderOpen" | "Table"): string {
  const caseStart = treeItemSource.indexOf(`case "${nodeType}"`);
  assert.notEqual(caseStart, -1, `Could not find TreeItem ${nodeType} mapping`);
  const nextCase = treeItemSource.indexOf("\n    case ", caseStart + 1);
  const caseBlock = treeItemSource.slice(caseStart, nextCase === -1 ? undefined : nextCase);
  const colorClass = caseBlock.match(new RegExp(`return \\{ icon: ${iconName}, colorClass: "([^"]+)" \\}`))?.[1];
  assert.ok(colorClass, `Could not find TreeItem ${nodeType} color`);
  return colorClass;
}

test("GridFS sidebar nodes use a dedicated cool-color icon treatment", () => {
  const gridfs = getTreeNodeIconInfo({ type: "mongo-gridfs" } as TreeNode);
  const bucket = getTreeNodeIconInfo({ type: "mongo-bucket" } as TreeNode);

  assert.equal(gridfs?.colorClass, "text-cyan-500");
  assert.equal(bucket?.colorClass, "text-cyan-400");
});

test("GridFS sidebar icon mapping stays distinct from Mongo collections", () => {
  const gridfs = getTreeNodeIconInfo({ type: "mongo-gridfs" } as TreeNode);
  const collection = getTreeNodeIconInfo({ type: "mongo-collection" } as TreeNode);

  assert.notEqual(gridfs?.colorClass, collection?.colorClass);
});

test("schema and table sidebar icon colors stay consistent and distinct", () => {
  const schema = getTreeNodeIconInfo({ type: "schema" } as TreeNode);
  const table = getTreeNodeIconInfo({ type: "table" } as TreeNode);
  const treeItemSchemaColor = treeItemIconColorClass("schema", "FolderOpen");
  const treeItemTableColor = treeItemIconColorClass("table", "Table");

  assert.equal(treeItemSchemaColor, schema?.colorClass);
  assert.equal(treeItemTableColor, table?.colorClass);
  assert.notEqual(treeItemSchemaColor, treeItemTableColor);
});

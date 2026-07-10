import assert from "node:assert/strict";
import { test } from "vitest";
import { getTreeNodeIconInfo } from "../../apps/desktop/src/lib/sidebar/treeNodeIcon.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

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

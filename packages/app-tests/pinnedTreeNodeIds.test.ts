import { test } from "vitest";
import assert from "node:assert/strict";
import { prunePinnedTreeNodeIdsForConnection } from "../../apps/desktop/src/lib/pinnedTreeNodeIds.ts";

test("prunePinnedTreeNodeIdsForConnection removes pinned ids for a deleted connection", () => {
  const ids = new Set(["conn-1", "conn-1:db:main", "conn-1:db:main:table:users", "conn-10:db:main", "other"]);

  const next = prunePinnedTreeNodeIdsForConnection(ids, "conn-1");

  assert.deepEqual([...next], ["conn-10:db:main", "other"]);
});

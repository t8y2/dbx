import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canCloseSidebarDatabaseConnection, isSidebarDatabaseOpened } from "../../apps/desktop/src/lib/sidebar/sidebarDatabaseOpenState.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

function databaseNode(id: string): TreeNode {
  return {
    id,
    label: "app",
    type: "database",
    connectionId: "conn-1",
    database: "app",
  };
}

test("database open state is based on the database node children cache", () => {
  const opened = databaseNode("conn-1:app");
  const unopened = databaseNode("conn-1:other");
  unopened.label = "other";
  unopened.database = "other";

  const loadedIds = new Set([opened.id]);
  const isLoaded = (id: string) => loadedIds.has(id);

  assert.equal(isSidebarDatabaseOpened(opened, isLoaded), true);
  assert.equal(canCloseSidebarDatabaseConnection(opened, isLoaded), true);
  assert.equal(isSidebarDatabaseOpened(unopened, isLoaded), false);
  assert.equal(canCloseSidebarDatabaseConnection(unopened, isLoaded), false);
});

test("non-SQL database nodes can be marked open without showing close database connection", () => {
  const mongoDatabase: TreeNode = {
    id: "mongo:app",
    label: "app",
    type: "mongo-db",
    connectionId: "mongo",
    database: "app",
  };
  const isLoaded = (id: string) => id === mongoDatabase.id;

  assert.equal(isSidebarDatabaseOpened(mongoDatabase, isLoaded), true);
  assert.equal(canCloseSidebarDatabaseConnection(mongoDatabase, isLoaded), false);
});

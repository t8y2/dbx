import assert from "node:assert/strict";
import { test } from "vitest";
import { collectionListToTableInfos } from "../src/database.js";

test("maps legacy collection name responses to table infos", () => {
  assert.deepEqual(collectionListToTableInfos(["projects", "users"]), [
    { name: "projects", type: "COLLECTION" },
    { name: "users", type: "COLLECTION" },
  ]);
});

test("maps collection info responses to table infos", () => {
  assert.deepEqual(
    collectionListToTableInfos([
      { name: "projects", id: "projects", dimension: null },
      { name: "embeddings", id: "uuid-123", dimension: 384 },
    ]),
    [
      { name: "projects", type: "COLLECTION" },
      { name: "embeddings", type: "COLLECTION" },
    ],
  );
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { buildAgentDownloadCatalog } from "./agentRegistry";

test("offline download catalog includes the JDBC plugin ZIP", () => {
  const catalog = buildAgentDownloadCatalog([]);

  assert.deepEqual(catalog.jdbcPlugin, {
    label: "DBX JDBC Plugin",
    filename: "dbx-jdbc-plugin-latest.zip",
    url: "https://dl.dbxio.com/releases/latest/dbx-jdbc-plugin-latest.zip",
  });
});

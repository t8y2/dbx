import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { MAX_RECENT_CONNECTION_IDS, parseRecentConnectionIds, rankRecentConnections, recordRecentConnection } from "../../apps/desktop/src/lib/connection/recentConnections.ts";

interface Connection {
  id: string;
  name: string;
}

function connections(...ids: string[]): Connection[] {
  return ids.map((id) => ({ id, name: `Connection ${id}` }));
}

test("recent connections rank MRU IDs first, backfill saved order, and cap the card", () => {
  const saved = connections("one", "two", "three", "four", "five", "six");

  assert.deepEqual(
    rankRecentConnections(saved, ["six", "three"]).map((connection) => connection.id),
    ["six", "three", "one", "two", "four"],
  );
});

test("recording a connection moves it to the front without duplicates", () => {
  assert.deepEqual(recordRecentConnection(["three", "two", "one"], "two"), ["two", "three", "one"]);

  const history = ["six", "five", "four", "three", "two"];
  assert.deepEqual(recordRecentConnection(history, "one"), ["one", "six", "five", "four", "three"]);
  assert.equal(recordRecentConnection(history, "").length, history.length);
  assert.equal(
    recordRecentConnection(
      connections(...history).map((connection) => connection.id),
      "one",
    ).length,
    MAX_RECENT_CONNECTION_IDS,
  );
});

test("recording the current MRU reuses the history so persistence can skip duplicate writes", () => {
  const history = ["three", "two", "one"];

  assert.equal(recordRecentConnection(history, "three"), history);
  assert.equal(recordRecentConnection(history, ""), history);
  assert.notEqual(recordRecentConnection(history, "two"), history);
});

test("persisted MRU order survives serialization and ignores malformed history", () => {
  const recorded = recordRecentConnection(recordRecentConnection([], "two"), "four");
  const restored = parseRecentConnectionIds(JSON.stringify(recorded));

  assert.deepEqual(restored, ["four", "two"]);
  assert.deepEqual(
    rankRecentConnections(connections("one", "two", "three", "four"), restored).map((connection) => connection.id),
    ["four", "two", "one", "three"],
  );
  assert.deepEqual(parseRecentConnectionIds("not-json"), []);
  assert.deepEqual(parseRecentConnectionIds(JSON.stringify({ connectionId: "one" })), []);
});

test("stale and duplicate IDs are ignored before saved-order backfill", () => {
  const restored = parseRecentConnectionIds(JSON.stringify(["missing", "two", "two", 42, " one "]));
  const saved = connections("one", "two", "three", "four", "five", "six");

  assert.deepEqual(restored, ["missing", "two", "one"]);
  assert.deepEqual(
    rankRecentConnections(saved, restored).map((connection) => connection.id),
    ["two", "one", "three", "four", "five"],
  );
});

test("empty history preserves saved order and recency follows stable IDs after rename", () => {
  const saved = connections("one", "two", "three");
  assert.deepEqual(
    rankRecentConnections(saved, []).map((connection) => connection.id),
    ["one", "two", "three"],
  );

  const renamed = saved.map((connection) => (connection.id === "two" ? { ...connection, name: "Renamed" } : connection));
  assert.deepEqual(
    rankRecentConnections(renamed, ["two"]).map((connection) => connection.name),
    ["Renamed", "Connection one", "Connection three"],
  );
});

test("App wires active connection changes and Quick Start opens into the MRU history", () => {
  const source = readFileSync("apps/desktop/src/App.vue", "utf8");

  assert.ok(source.includes("rankRecentConnections(connectionStore.connections, recentConnectionIds.value)"));
  assert.ok(source.includes("if (nextIds === recentConnectionIds.value) return;"));
  assert.match(source, /watch\(\s*\(\) => connectionStore\.activeConnectionId,\s*rememberRecentConnection,?\s*\);/);
  assert.match(source, /async function openConnectionQuery\(connectionId: string\)[\s\S]*?rememberRecentConnection\(connectionId\);/);
});

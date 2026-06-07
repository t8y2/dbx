import { strict as assert } from "node:assert";
import test from "node:test";
import { objectSourceSaveExecutionMode, supportsSourceBackedRoutineRename } from "../../apps/desktop/src/lib/objectSourceEditor.ts";

test("object source saves use single statement execution mode", () => {
  assert.equal(objectSourceSaveExecutionMode("sqlserver"), "single");
  assert.equal(objectSourceSaveExecutionMode("kingbase"), "single");
  assert.equal(objectSourceSaveExecutionMode("postgres"), "single");
  assert.equal(objectSourceSaveExecutionMode("gaussdb"), "single");
  assert.equal(objectSourceSaveExecutionMode("mysql"), "single");
});

test("routine rename capability stays available for source-backed engines", () => {
  assert.equal(supportsSourceBackedRoutineRename("dameng", "PROCEDURE"), true);
  assert.equal(supportsSourceBackedRoutineRename("oracle", "FUNCTION"), true);
  assert.equal(supportsSourceBackedRoutineRename("mysql", "PROCEDURE"), true);
  assert.equal(supportsSourceBackedRoutineRename("postgres", "FUNCTION"), true);
  assert.equal(supportsSourceBackedRoutineRename("sqlserver", "PROCEDURE"), false);
  assert.equal(supportsSourceBackedRoutineRename("postgres", "VIEW"), false);
});

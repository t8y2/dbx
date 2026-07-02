import { strict as assert } from "node:assert";
import { test } from "vitest";
import { isEnumColumn, enumValuesForColumn } from "../../apps/desktop/src/lib/dataGridEnumEditor.ts";

test("detects MySQL enum column types", () => {
  assert.equal(isEnumColumn({ data_type: "enum('pending','active','archived')" }), true);
  assert.equal(isEnumColumn({ data_type: "ENUM('yes','no')" }), true);
  assert.equal(isEnumColumn({ data_type: "enum('a')" }), true);
  assert.equal(isEnumColumn({ data_type: "enum( 'a' , 'b' )" }), true);
});

test("rejects non-enum column types", () => {
  assert.equal(isEnumColumn({ data_type: "varchar(255)" }), false);
  assert.equal(isEnumColumn({ data_type: "int" }), false);
  assert.equal(isEnumColumn({ data_type: "" }), false);
  assert.equal(isEnumColumn(undefined), false);
  assert.equal(isEnumColumn({ data_type: "enum" }), false);
});

test("parses standard enum values", () => {
  assert.deepEqual(enumValuesForColumn({ data_type: "enum('pending','active','archived')" }), ["pending", "active", "archived"]);
  assert.deepEqual(enumValuesForColumn({ data_type: "ENUM('yes','no')" }), ["yes", "no"]);
  assert.deepEqual(enumValuesForColumn({ data_type: "enum('a')" }), ["a"]);
});

test("parses enum values with spaces", () => {
  assert.deepEqual(enumValuesForColumn({ data_type: "enum( 'pending' , 'active' , 'archived' )" }), ["pending", "active", "archived"]);
});

test("parses enum with escaped single quotes", () => {
  assert.deepEqual(enumValuesForColumn({ data_type: "enum('it''s','normal')" }), ["it's", "normal"]);
});

test("parses MySQL enum values with charset and collation suffixes", () => {
  assert.deepEqual(
    enumValuesForColumn({
      data_type: "enum('id','string','text','long','double','bool','date','datetime','object','secret') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
    }),
    ["id", "string", "text", "long", "double", "bool", "date", "datetime", "object", "secret"],
  );
});

test("returns empty array for non-enum types", () => {
  assert.deepEqual(enumValuesForColumn({ data_type: "varchar(255)" }), []);
  assert.deepEqual(enumValuesForColumn(undefined), []);
});

test("multiline enum type", () => {
  assert.deepEqual(
    enumValuesForColumn({
      data_type: `enum('small','medium','large')`,
    }),
    ["small", "medium", "large"],
  );
});

import { strict as assert } from "node:assert";
import test from "node:test";
import { displayCellValue } from "../src/lib/cellValue.ts";

test("displayCellValue returns NULL for null", () => {
  assert.equal(displayCellValue(null), "NULL");
});

test("displayCellValue returns string representation for booleans", () => {
  assert.equal(displayCellValue(true), "true");
  assert.equal(displayCellValue(false), "false");
});

test("displayCellValue returns String for numbers", () => {
  assert.equal(displayCellValue(42), "42");
  assert.equal(displayCellValue(-3.14), "-3.14");
  assert.equal(displayCellValue(0), "0");
});

test("displayCellValue returns String for strings", () => {
  assert.equal(displayCellValue("hello"), "hello");
  assert.equal(displayCellValue(""), "");
});

test("displayCellValue does not truncate long strings", () => {
  const long = "a".repeat(1000);
  assert.equal(displayCellValue(long), long);
});

test("displayCellValue serializes JSON strings containing complex nested objects", () => {
  const payload = '{"metadata":{"version":"2.1.0","tags":["alpha","beta"],"flags":{"enabled":true,"nested":{"depth":3,"items":[{"id":1,"label":"a"},{"id":2,"label":"b"}]}}},"data":{"records":[{"key":"k-001","value":42},{"key":"k-002","value":-999}],"summary":{"total":3,"valid":2}}}';
  assert.equal(displayCellValue(payload), payload);
});

test("displayCellValue handles strings with unicode and special characters", () => {
  const unicodeStr = "你好世界 🚀🎉 <div>test</div> Line1\nLine2\tTabbed";
  assert.equal(displayCellValue(unicodeStr), unicodeStr);
});

test("displayCellValue handles large integer and scientific notation as strings", () => {
  const bigIntStr = "9007199254740991";
  const sciStr = "1e-10";
  assert.equal(displayCellValue(bigIntStr), bigIntStr);
  assert.equal(displayCellValue(sciStr), sciStr);
});

test("displayCellValue handles empty JSON-like strings without alteration", () => {
  assert.equal(displayCellValue("{}"), "{}");
  assert.equal(displayCellValue("[]"), "[]");
  assert.equal(displayCellValue('{"key":"value"}'), '{"key":"value"}');
  assert.equal(displayCellValue("[1,2,3]"), "[1,2,3]");
});
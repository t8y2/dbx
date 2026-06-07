import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveHeaderColumnType } from "../../apps/desktop/src/lib/dataGridColumnType.ts";

test("prefers table-metadata type over the result type", () => {
  const type = resolveHeaderColumnType({
    tableColumnType: "numeric(20,6)",
    resultColumnTypes: ["int4"],
    actualColIdx: 0,
  });
  assert.equal(type, "numeric(20,6)");
});

test("falls back to the result type at the column index when no table meta", () => {
  const type = resolveHeaderColumnType({
    tableColumnType: undefined,
    resultColumnTypes: ["oid", "char", "bigint"],
    actualColIdx: 1,
  });
  assert.equal(type, "char");
});

test("uses actualColIdx (by index), not column order assumptions", () => {
  // The third result column should resolve to the third type, regardless of
  // any name-based reordering elsewhere.
  const type = resolveHeaderColumnType({
    resultColumnTypes: ["a_type", "b_type", "c_type"],
    actualColIdx: 2,
  });
  assert.equal(type, "c_type");
});

test("returns undefined when the result type index is out of range", () => {
  const type = resolveHeaderColumnType({
    resultColumnTypes: ["int4"],
    actualColIdx: 5,
  });
  assert.equal(type, undefined);
});

test("returns undefined when neither source has a type", () => {
  assert.equal(resolveHeaderColumnType({ actualColIdx: 0 }), undefined);
  assert.equal(resolveHeaderColumnType({ resultColumnTypes: [], actualColIdx: 0 }), undefined);
});

test("treats blank/whitespace types as absent and falls through", () => {
  const type = resolveHeaderColumnType({
    tableColumnType: "   ",
    resultColumnTypes: ["text"],
    actualColIdx: 0,
  });
  assert.equal(type, "text");

  assert.equal(
    resolveHeaderColumnType({ tableColumnType: "", resultColumnTypes: [""], actualColIdx: 0 }),
    undefined,
  );
});

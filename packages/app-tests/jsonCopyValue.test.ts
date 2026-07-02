import { strict as assert } from "node:assert";
import { test } from "vitest";
import { expandNestedJsonStringsForCopy } from "../../apps/desktop/src/lib/jsonCopyValue.ts";

test("expands nested JSON strings for copied rows", () => {
  const value = {
    _id: "67218700e884ae1f527640b6",
    accountId: 581,
    data: '{"endingBalance":{"beginningBalance":"0","endingBalance":"20000","endingDate":"2024-10-30"},"financeChargeInfo":null,"interestChargeInfo":null,"Line":[]}',
    status: "draft",
  };

  assert.deepEqual(expandNestedJsonStringsForCopy(value), {
    _id: "67218700e884ae1f527640b6",
    accountId: 581,
    data: {
      endingBalance: {
        beginningBalance: "0",
        endingBalance: "20000",
        endingDate: "2024-10-30",
      },
      financeChargeInfo: null,
      interestChargeInfo: null,
      Line: [],
    },
    status: "draft",
  });
});

test("recursively expands JSON strings in arrays and objects", () => {
  const value = {
    items: ['{"id":1,"meta":"{\\"ok\\":true}"}', "plain text"],
  };

  assert.deepEqual(expandNestedJsonStringsForCopy(value), {
    items: [{ id: 1, meta: { ok: true } }, "plain text"],
  });
});

test("keeps non-object JSON-like cell strings unchanged", () => {
  assert.equal(expandNestedJsonStringsForCopy("123"), "123");
  assert.equal(expandNestedJsonStringsForCopy('"text"'), '"text"');
  assert.equal(expandNestedJsonStringsForCopy("2024-10-30T01:08:14.454Z"), "2024-10-30T01:08:14.454Z");
});

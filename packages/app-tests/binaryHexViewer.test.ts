import assert from "node:assert/strict";
import { test } from "vitest";
import { buildBinaryHexViewRows } from "../../apps/desktop/src/lib/binaryHexViewer.ts";

test("buildBinaryHexViewRows formats offsets, hex bytes, and ascii preview", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x20, 0x41, 0x7e, 0x7f, 0x00, 0x01, 0x02, 0xff, 0x48]);

  assert.deepEqual(buildBinaryHexViewRows(bytes), [
    {
      offset: "00000000",
      hex: "89 50 4E 47 0D 0A 1A 0A 20 41 7E 7F 00 01 02 FF",
      ascii: ".PNG.... A~.....",
    },
    {
      offset: "00000010",
      hex: "48",
      ascii: "H",
    },
  ]);
});

test("buildBinaryHexViewRows handles empty binary values", () => {
  assert.deepEqual(buildBinaryHexViewRows(new Uint8Array()), []);
});

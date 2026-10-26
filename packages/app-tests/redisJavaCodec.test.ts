import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { parseJavaSerializedDetail } from "../../apps/desktop/src/lib/redis/codec/javaSerialized.ts";

const fixtures = JSON.parse(fs.readFileSync(new URL("../../crates/dbx-formats/tests/fixtures/redis_java.json", import.meta.url), "utf8")) as Array<{ name: string; hex: string; expected: unknown }>;

for (const fixture of fixtures) {
  test(`Java codec shared Rust/desktop fixture: ${fixture.name}`, () => {
    const result = parseJavaSerializedDetail(Buffer.from(fixture.hex, "hex"));
    assert.deepEqual(result?.value, fixture.expected);
  });
}

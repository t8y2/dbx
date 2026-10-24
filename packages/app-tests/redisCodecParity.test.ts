import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { decodeMsgpack } from "../../apps/desktop/src/lib/redis/codec/msgpack.ts";
import { decodePhpSerialized } from "../../apps/desktop/src/lib/redis/codec/phpSerialize.ts";
import { decodePickle } from "../../apps/desktop/src/lib/redis/codec/pickle.ts";
import { decodeProtobuf } from "../../apps/desktop/src/lib/redis/codec/protobuf.ts";

const fixtures = JSON.parse(fs.readFileSync(new URL("../../crates/dbx-formats/tests/fixtures/redis_codecs.json", import.meta.url), "utf8")) as Array<{ name: string; codec: string; hex: string; expected: unknown }>;
const decoders = { msgpack: decodeMsgpack, pickle: decodePickle, "php-serialize": decodePhpSerialized, protobuf: decodeProtobuf };
for (const fixture of fixtures) {
  test(`shared Redis codec fixture: ${fixture.name}`, () => {
    const decoder = decoders[fixture.codec as keyof typeof decoders];
    assert.deepEqual(decoder(Buffer.from(fixture.hex, "hex"))?.value, fixture.expected);
  });
}

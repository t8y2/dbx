import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { decodePayload, encodePayload } from "@/lib/mqtt/mqttPayloadCodec";

test("MQTT plaintext payloads preserve UTF-8 content", () => {
  const input = "temperature=21.5 🌡️";
  assert.equal(decodePayload(encodePayload(input, "plaintext"), "plaintext"), input);
});

test("MQTT JSON payloads are validated and canonicalized", () => {
  const encoded = encodePayload(' { "enabled": true, "count": 2 } ', "json");
  assert.equal(decodePayload(encoded, "plaintext"), '{"enabled":true,"count":2}');
  assert.equal(decodePayload(encoded, "json"), '{\n  "enabled": true,\n  "count": 2\n}');
});

test("MQTT Base64 payloads preserve bytes and use canonical encoding", () => {
  assert.equal(encodePayload("AP+A", "base64"), "AP+A");
  assert.equal(encodePayload("Y Q", "base64"), "YQ==");
  assert.equal(encodePayload("YR==", "base64"), "YQ==");
});

test("MQTT hex payloads allow whitespace and reject malformed input", () => {
  const encoded = encodePayload("48 65\n6c\t6c 6f", "hex");
  assert.equal(decodePayload(encoded, "plaintext"), "Hello");
  assert.throws(() => encodePayload("abc", "hex"), /编码失败 \(Hex\)/);
  assert.throws(() => encodePayload("zz", "hex"), /编码失败 \(Hex\)/);
});

test("MQTT CBOR payloads round-trip JSON values", () => {
  const encoded = encodePayload('{"sensor":"outside","values":[1,2,3]}', "cbor");
  assert.deepEqual(JSON.parse(decodePayload(encoded, "cbor")), { sensor: "outside", values: [1, 2, 3] });
});

test("MQTT MessagePack payloads round-trip JSON values", () => {
  const encoded = encodePayload('{"sensor":"inside","ok":true}', "msgpack");
  assert.deepEqual(JSON.parse(decodePayload(encoded, "msgpack")), { sensor: "inside", ok: true });
});

test("MQTT structured decode falls back without throwing", () => {
  const encoded = encodePayload("not-json", "plaintext");
  assert.equal(decodePayload(encoded, "json"), "not-json");
  assert.equal(decodePayload(encoded, "cbor"), "not-json");
  assert.equal(decodePayload(encoded, "msgpack"), "not-json");
});

test("MQTT empty payloads remain empty", () => {
  assert.equal(encodePayload("", "plaintext"), "");
  assert.equal(decodePayload("", "plaintext"), "");
});

test("MQTT JSON publishing sends canonical bytes instead of the original text", () => {
  const source = readFileSync("apps/desktop/src/components/mqtt/MqttPublishDialog.vue", "utf8");
  assert.match(source, /payloadText:\s*encoding\.value === "plaintext" \? payloadText\.value : null/);
  assert.doesNotMatch(source, /encoding\.value === "plaintext" \|\| encoding\.value === "json"/);
});

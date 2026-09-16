import { describe, expect, it } from "vitest";
import { decodeBase64RedisValue } from "../base64";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("decodeBase64RedisValue", () => {
  it("decodes padded and unpadded base64 text", () => {
    expect(decodeBase64RedisValue(bytes("eyJpZCI6MX0="))).toBe('{"id":1}');
    expect(decodeBase64RedisValue(bytes("eyJpZCI6MX0"))).toBe('{"id":1}');
  });

  it("ignores wrapping newlines", () => {
    expect(decodeBase64RedisValue(bytes("eyJpZA\n=="))).toBe('{"id');
  });

  it("rejects plain text that is not clean base64", () => {
    expect(decodeBase64RedisValue(bytes("hello world!"))).toBeNull();
    expect(decodeBase64RedisValue(bytes("{"))).toBeNull();
    expect(decodeBase64RedisValue(bytes(""))).toBeNull();
  });
});

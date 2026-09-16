import { describe, expect, it } from "vitest";
import { decodeProtobuf } from "../protobuf";

describe("decodeProtobuf", () => {
  it("decodes varints and length-delimited strings", () => {
    // field 1 varint 150, field 2 string "hello dbx" — canonical proto3 encoding
    const payload = Uint8Array.from([0x08, 0x96, 0x01, 0x12, 0x09, ...new TextEncoder().encode("hello dbx")]);
    expect(decodeProtobuf(payload)?.value).toEqual({ 1: 150, 2: "hello dbx" });
  });

  it("renders repeated fields as arrays", () => {
    // field 3 string "a", field 3 string "b"
    const payload = Uint8Array.from([0x1a, 0x01, 0x61, 0x1a, 0x01, 0x62]);
    expect(decodeProtobuf(payload)?.value).toEqual({ 3: ["a", "b"] });
  });

  it("decodes nested messages when the payload parses as one", () => {
    // outer field 1 = nested {field 1 varint 7}
    const payload = Uint8Array.from([0x0a, 0x02, 0x08, 0x07]);
    expect(decodeProtobuf(payload)?.value).toEqual({ 1: { 1: 7 } });
  });

  it("renders non-text delimited bytes as hex", () => {
    // field 1 = bytes [0x00, 0xff] — NUL fails the text check
    const payload = Uint8Array.from([0x0a, 0x02, 0x00, 0xff]);
    expect(decodeProtobuf(payload)?.value).toEqual({ 1: { $bytes: "00ff" } });
  });

  it("keeps large varints exact", () => {
    // field 1 = 2^62
    const payload = Uint8Array.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40]);
    expect(decodeProtobuf(payload)?.value).toEqual({ 1: "4611686018427387904" });
  });

  it("rejects empty and truncated payloads", () => {
    expect(decodeProtobuf(new Uint8Array())).toBeNull();
    // field 1 length-delimited claiming 9 bytes but only 4 follow
    expect(decodeProtobuf(Uint8Array.from([0x0a, 0x09, 0x68, 0x65, 0x6c, 0x6c]))).toBeNull();
  });
});

import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { decodeMsgpack } from "../msgpack";

describe("decodeMsgpack", () => {
  it("decodes objects, arrays, and scalars", () => {
    expect(decodeMsgpack(encode({ task: "add", value: 3 }))?.value).toEqual({ task: "add", value: 3 });
    expect(decodeMsgpack(encode(["hello", 1, null, true]))?.value).toEqual(["hello", 1, null, true]);
    expect(decodeMsgpack(encode("plain"))?.value).toBe("plain");
  });

  it("rejects empty and corrupt payloads instead of guessing", () => {
    expect(decodeMsgpack(new Uint8Array(0))).toBeNull();
    expect(decodeMsgpack(new Uint8Array([0xc1]))).toBeNull();
  });
});

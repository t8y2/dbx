import { describe, expect, it } from "vitest";
import { decodePhpSerialized } from "../phpSerialize";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("decodePhpSerialized", () => {
  it("decodes arrays, maps, and scalars", () => {
    expect(decodePhpSerialized(bytes('a:3:{i:0;s:9:"hello dbx";i:1;i:42;i:2;b:1;}'))?.value).toEqual(["hello dbx", 42, true]);
    expect(decodePhpSerialized(bytes('a:2:{s:3:"msg";s:9:"hello dbx";s:5:"count";d:1.5;}'))?.value).toEqual({ msg: "hello dbx", count: 1.5 });
    expect(decodePhpSerialized(bytes("N;"))?.value).toBeNull();
    expect(decodePhpSerialized(bytes('s:9:"hello dbx";'))?.value).toBe("hello dbx");
  });

  it("decodes objects with their class name", () => {
    expect(decodePhpSerialized(bytes('O:8:"JobState":2:{s:5:"state";s:4:"done";s:7:"retries";i:0;}'))?.value).toEqual({
      $class: "JobState",
      state: "done",
      retries: 0,
    });
  });

  it("measures string lengths in bytes, not characters", () => {
    // "你好" is 2 characters but 6 UTF-8 bytes.
    expect(decodePhpSerialized(bytes('s:6:"你好";'))?.value).toBe("你好");
    expect(decodePhpSerialized(bytes('a:1:{s:5:"label";s:6:"你好";}'))?.value).toEqual({ label: "你好" });
  });

  it("decodes nested structures", () => {
    expect(decodePhpSerialized(bytes('a:1:{s:5:"outer";a:2:{i:0;s:3:"one";i:1;a:1:{i:0;i:7;}}}?'))).toBeNull();
    expect(decodePhpSerialized(bytes('a:1:{s:5:"outer";a:2:{i:0;s:3:"one";i:1;a:1:{i:0;i:7;}}}'))?.value).toEqual({ outer: ["one", [7]] });
  });

  it("rejects non-serialized payloads and truncation", () => {
    expect(decodePhpSerialized(bytes("hello dbx"))).toBeNull();
    expect(decodePhpSerialized(bytes('a:2:{i:0;s:9:"hello dbx";}'))).toBeNull();
    expect(decodePhpSerialized(bytes('s:99:"short";'))).toBeNull();
  });
});

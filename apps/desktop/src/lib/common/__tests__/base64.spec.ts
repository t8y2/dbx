import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64ToBytes } from "../base64";

const allByteValues = Uint8Array.from({ length: 256 }, (_, index) => index);
const allByteValuesBase64 = btoa(String.fromCharCode(...allByteValues));

const holder = Uint8Array as unknown as { fromBase64?: unknown };
const originalFromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");

function setNativeFromBase64(value: unknown) {
  Object.defineProperty(Uint8Array, "fromBase64", { value, configurable: true, writable: true });
}

describe("decodeBase64ToBytes", () => {
  afterEach(() => {
    if (originalFromBase64) Object.defineProperty(Uint8Array, "fromBase64", originalFromBase64);
    else delete holder.fromBase64;
  });

  it("decodes every byte value through the atob fallback", () => {
    setNativeFromBase64(undefined);
    expect(decodeBase64ToBytes(allByteValuesBase64)).toEqual(allByteValues);
  });

  it("handles empty input and each padding length through the fallback", () => {
    setNativeFromBase64(undefined);
    expect(decodeBase64ToBytes("")).toEqual(new Uint8Array());
    expect(decodeBase64ToBytes(btoa("a"))).toEqual(new Uint8Array([97]));
    expect(decodeBase64ToBytes(btoa("ab"))).toEqual(new Uint8Array([97, 98]));
    expect(decodeBase64ToBytes(btoa("abc"))).toEqual(new Uint8Array([97, 98, 99]));
  });

  it("ignores ASCII whitespace like the native decoder does", () => {
    setNativeFromBase64(undefined);
    expect(decodeBase64ToBytes("YWJj\nZGVm")).toEqual(new TextEncoder().encode("abcdef"));
  });

  it("throws on invalid input through the fallback", () => {
    setNativeFromBase64(undefined);
    expect(() => decodeBase64ToBytes("not base64!")).toThrow();
  });

  it("prefers the native decoder when the runtime provides it", () => {
    const native = vi.fn((value: string) => new Uint8Array([value.length]));
    setNativeFromBase64(native);
    const atobSpy = vi.spyOn(globalThis, "atob");

    expect(decodeBase64ToBytes("QUJD")).toEqual(new Uint8Array([4]));
    expect(native).toHaveBeenCalledWith("QUJD");
    // Called as a static method so `this` is Uint8Array, as the spec requires.
    expect(native.mock.contexts[0]).toBe(Uint8Array);
    expect(atobSpy).not.toHaveBeenCalled();
    atobSpy.mockRestore();
  });
});

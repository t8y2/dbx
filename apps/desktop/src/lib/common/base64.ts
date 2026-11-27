type NativeFromBase64 = (base64: string) => Uint8Array<ArrayBuffer>;

/**
 * Decode standard base64 into bytes for payloads that can be megabytes.
 *
 * `Uint8Array.from(atob(value), (c) => c.charCodeAt(0))` runs one JS callback
 * per byte on the main thread. In JavaScriptCore that is roughly a second per
 * 5 MB, so decoding the ~25 MB io.dbx.ssh ui build froze the window for
 * seconds; the native decoder does the same in single-digit milliseconds.
 *
 * `Uint8Array.fromBase64` ships in WebKit 18.2+ and current Chromium. Older
 * WebViews (older macOS, webkit2gtk) fall back to a plain indexed loop, which
 * is still several times faster than the per-byte callback. Both paths ignore
 * ASCII whitespace and throw on invalid input.
 */
export function decodeBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: NativeFromBase64 }).fromBase64;
  if (typeof native === "function") return native.call(Uint8Array, base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

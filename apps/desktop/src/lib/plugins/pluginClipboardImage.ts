import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export const MAX_PLUGIN_CLIPBOARD_IMAGE_BYTES = 18 * 1024 * 1024;
export const MAX_PLUGIN_CLIPBOARD_IMAGE_BASE64 = 24 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

export function requirePluginClipboardImage(params: unknown, binary?: ArrayBuffer): Uint8Array {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("host.copyImage requires PNG image options");
  const input = params as Record<string, unknown>;
  if (input.contentType !== "image/png") throw new Error("host.copyImage only supports image/png");
  let bytes: Uint8Array;
  if (binary instanceof ArrayBuffer) {
    if (binary.byteLength > MAX_PLUGIN_CLIPBOARD_IMAGE_BYTES) throw new Error("Clipboard image exceeds the 18 MiB limit");
    bytes = new Uint8Array(binary);
  } else {
    const encoded = input.dataBase64;
    if (typeof encoded !== "string" || encoded.length > MAX_PLUGIN_CLIPBOARD_IMAGE_BASE64) throw new Error("Clipboard image requires base64 or transferred binary data within the 18 MiB limit");
    if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Clipboard image data must be base64");
    const decoded = atob(encoded);
    bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  }
  // Bound RGBA allocation before a native decoder touches untrusted PNG bytes.
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) throw new Error("Clipboard image must contain a PNG");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) throw new Error("Clipboard image has an invalid PNG header");
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error("Clipboard image exceeds the 16 megapixel limit");
  return bytes;
}

export function canWritePluginClipboardImage(): boolean {
  return isTauriRuntime() || (typeof ClipboardItem !== "undefined" && typeof navigator !== "undefined" && typeof navigator.clipboard?.write === "function");
}

export async function writePluginClipboardImage(bytes: Uint8Array): Promise<void> {
  if (isTauriRuntime()) {
    const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeImage(bytes);
    return;
  }
  if (!canWritePluginClipboardImage()) throw new Error("Host clipboard image write is unavailable");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) })]);
}

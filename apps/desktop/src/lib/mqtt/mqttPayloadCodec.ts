/**
 * MQTT Payload 编解码工具
 * 支持 Plaintext / JSON / Base64 / Hex / CBOR / MsgPack 六种格式
 */
import { decode as cborDecode, encode as cborEncode } from "cbor-x";
import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";

/** 支持的编码格式 */
export type PayloadEncoding = "plaintext" | "json" | "base64" | "hex" | "cbor" | "msgpack";

export const PAYLOAD_ENCODING_LABELS: Record<PayloadEncoding, string> = {
  plaintext: "Plaintext",
  json: "JSON",
  base64: "Base64",
  hex: "Hex",
  cbor: "CBOR",
  msgpack: "MsgPack",
};

export const PAYLOAD_ENCODINGS: PayloadEncoding[] = ["plaintext", "json", "base64", "hex", "cbor", "msgpack"];

/**
 * 将 base64 编码的 payload 按指定格式解码为可展示的字符串
 */
export function decodePayload(base64: string, encoding: PayloadEncoding): string {
  if (!base64) return "";

  try {
    const bytes = base64ToBytes(base64);

    switch (encoding) {
      case "plaintext":
        return bytesToUtf8(bytes);

      case "json": {
        const text = bytesToUtf8(bytes);
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed, null, 2);
      }

      case "base64":
        return base64;

      case "hex":
        return bytesToHex(bytes);

      case "cbor": {
        const decoded = cborDecode(bytes);
        return formatDecodedValue(decoded);
      }

      case "msgpack": {
        const decoded = msgpackDecode(bytes);
        return formatDecodedValue(decoded);
      }

      default:
        return bytesToUtf8(bytes);
    }
  } catch {
    /* 解码失败时回退为纯文本显示 */
    try {
      return bytesToUtf8(base64ToBytes(base64));
    } catch {
      return `[解码失败] ${base64}`;
    }
  }
}

/**
 * 将用户输入的文本按指定格式编码为 base64（用于发布消息）
 */
export function encodePayload(input: string, encoding: PayloadEncoding): string {
  if (!input) return "";

  try {
    switch (encoding) {
      case "plaintext":
        return bytesToBase64(utf8ToBytes(input));

      case "json": {
        /* 确保输入是合法 JSON 后再编码 */
        const parsed = JSON.parse(input);
        return bytesToBase64(utf8ToBytes(JSON.stringify(parsed)));
      }

      case "base64":
        /* 浏览器 atob 接受缺失 padding 和空白；规范化后再交给 Rust 严格解码 */
        return bytesToBase64(base64ToBytes(input));

      case "hex": {
        const cleaned = input.replace(/\s/g, "");
        if (!/^([0-9A-Fa-f]{2})*$/.test(cleaned)) {
          throw new Error("无效的十六进制字符串");
        }
        const bytes = hexToBytes(cleaned);
        return bytesToBase64(bytes);
      }

      case "cbor": {
        /* 将 JSON 文本编码为 CBOR */
        const parsed = JSON.parse(input);
        const cborBytes = cborEncode(parsed);
        return bytesToBase64(cborBytes);
      }

      case "msgpack": {
        /* 将 JSON 文本编码为 MsgPack */
        const parsed = JSON.parse(input);
        const msgpackBytes = msgpackEncode(parsed);
        return bytesToBase64(msgpackBytes);
      }

      default:
        return bytesToBase64(utf8ToBytes(input));
    }
  } catch (e) {
    throw new Error(`编码失败 (${PAYLOAD_ENCODING_LABELS[encoding]}): ${String(e)}`);
  }
}

/* ========== 基础转换工具 ========== */

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function formatDecodedValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  /* Buffer / Uint8Array 等二进制类型 */
  if (value instanceof Uint8Array || (ArrayBuffer.isView(value) && (value as ArrayBufferView).byteLength !== undefined)) {
    return `[二进制数据, ${(value as Uint8Array).byteLength ?? (value as Uint8Array).length} bytes]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[二进制数据, ${value.byteLength} bytes]`;
  }
  /* 对象/数组 → JSON 格式化 */
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

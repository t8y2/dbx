import type { PeekedMessage } from "@/types/mq";

export type ThriftMessageType = "CALL" | "REPLY" | "EXCEPTION" | "ONEWAY";

export interface ThriftBinaryDecodeResult {
  formattedText: string;
  value: Record<string, unknown>;
}

const THRIFT_VERSION_MASK = 0xffff0000;
const THRIFT_VERSION_1 = 0x80010000;
const THRIFT_TYPE_MASK = 0x000000ff;
const MAX_DEPTH = 32;
const MAX_CONTAINER_ITEMS = 10_000;
const MAX_METHOD_NAME_LENGTH = 256;

const MESSAGE_TYPES: Record<number, ThriftMessageType> = {
  1: "CALL",
  2: "REPLY",
  3: "EXCEPTION",
  4: "ONEWAY",
};

const TType = {
  STOP: 0,
  VOID: 1,
  BOOL: 2,
  BYTE: 3,
  DOUBLE: 4,
  I16: 6,
  I32: 8,
  I64: 10,
  STRING: 11,
  STRUCT: 12,
  MAP: 13,
  SET: 14,
  LIST: 15,
  UUID: 16,
} as const;

class ThriftBinaryReader {
  private pos = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  remaining(): number {
    return this.bytes.length - this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  private ensure(size: number): void {
    if (size < 0 || this.pos + size > this.bytes.length) {
      throw new Error("truncated thrift payload");
    }
  }

  u8(): number {
    this.ensure(1);
    return this.bytes[this.pos++];
  }

  i8(): number {
    this.ensure(1);
    return this.view.getInt8(this.pos++);
  }

  i16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.pos, false);
    this.pos += 2;
    return value;
  }

  i32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return value;
  }

  u32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return value;
  }

  i64(): bigint {
    this.ensure(8);
    const value = this.view.getBigInt64(this.pos, false);
    this.pos += 8;
    return value;
  }

  f64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.pos, false);
    this.pos += 8;
    return value;
  }

  bytesSlice(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("invalid thrift byte length");
    }
    this.ensure(length);
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
}

export function isPrintableText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function decodeUtf8Printable(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return isPrintableText(text) ? text : null;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function decodeBinaryOrString(bytes: Uint8Array, depth: number): unknown {
  if (bytes.length === 0) return "";
  const text = decodeUtf8Printable(bytes);
  if (text !== null) return text;
  if (depth < MAX_DEPTH) {
    try {
      return decodeRawStruct(bytes, depth + 1);
    } catch {
      // Fall through to hex bytes representation.
    }
  }
  return { $bytes: bytesToHex(bytes) };
}

function readValue(reader: ThriftBinaryReader, type: number, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("thrift nesting too deep");
  switch (type) {
    case TType.VOID:
      return null;
    case TType.BOOL: {
      const raw = reader.u8();
      if (raw !== 0 && raw !== 1) throw new Error("invalid thrift bool");
      return raw === 1;
    }
    case TType.BYTE:
      return reader.i8();
    case TType.DOUBLE:
      return reader.f64();
    case TType.I16:
      return reader.i16();
    case TType.I32:
      return reader.i32();
    case TType.I64: {
      const raw = reader.i64();
      return raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw.toString();
    }
    case TType.STRING: {
      const length = reader.i32();
      return decodeBinaryOrString(reader.bytesSlice(length), depth);
    }
    case TType.STRUCT:
      return readStruct(reader, depth + 1);
    case TType.MAP: {
      const keyType = reader.u8();
      const valType = reader.u8();
      const size = reader.i32();
      if (size < 0 || size > MAX_CONTAINER_ITEMS || size > reader.remaining()) {
        throw new Error("invalid thrift map size");
      }
      const entries: Array<[unknown, unknown]> = [];
      let allPrimitiveKeys = true;
      for (let i = 0; i < size; i++) {
        const key = readValue(reader, keyType, depth + 1);
        const value = readValue(reader, valType, depth + 1);
        if (typeof key !== "string" && typeof key !== "number" && typeof key !== "boolean") {
          allPrimitiveKeys = false;
        }
        entries.push([key, value]);
      }
      if (allPrimitiveKeys) {
        return Object.fromEntries(entries.map(([key, value]) => [String(key), value]));
      }
      return entries;
    }
    case TType.SET:
    case TType.LIST: {
      const elemType = reader.u8();
      const size = reader.i32();
      if (size < 0 || size > MAX_CONTAINER_ITEMS || size > reader.remaining()) {
        throw new Error("invalid thrift list/set size");
      }
      const items: unknown[] = [];
      for (let i = 0; i < size; i++) {
        items.push(readValue(reader, elemType, depth + 1));
      }
      return items;
    }
    case TType.UUID:
      return formatUuid(reader.bytesSlice(16));
    default:
      throw new Error(`unsupported thrift type: ${type}`);
  }
}

function readStruct(reader: ThriftBinaryReader, depth: number): Record<string, unknown> {
  if (depth > MAX_DEPTH) throw new Error("thrift struct nesting too deep");
  const fields: Record<string, unknown> = {};
  while (true) {
    const fieldType = reader.u8();
    if (fieldType === TType.STOP) break;
    const fieldId = reader.i16();
    if (fieldId < 0) throw new Error("invalid thrift field id");
    const key = String(fieldId);
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new Error("duplicate thrift field id");
    }
    fields[key] = readValue(reader, fieldType, depth);
  }
  return fields;
}

function isValidMethodName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_METHOD_NAME_LENGTH) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f) return false;
  }
  return true;
}

function decodeStrictMessage(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ThriftBinaryReader(bytes);
  const versionAndType = reader.u32();
  if ((versionAndType & THRIFT_VERSION_MASK) >>> 0 !== THRIFT_VERSION_1) {
    throw new Error("not strict thrift v1 message");
  }
  if ((versionAndType & 0x0000ff00) !== 0) {
    throw new Error("invalid thrift v1 message flags");
  }
  const messageType = MESSAGE_TYPES[versionAndType & THRIFT_TYPE_MASK];
  if (!messageType) throw new Error("invalid thrift message type");
  const nameLength = reader.i32();
  if (nameLength <= 0 || nameLength > MAX_METHOD_NAME_LENGTH) {
    throw new Error("invalid thrift method name length");
  }
  const method = decodeUtf8Printable(reader.bytesSlice(nameLength));
  if (!method || !isValidMethodName(method)) {
    throw new Error("invalid thrift method name");
  }
  const seqId = reader.i32();
  const fields = readStruct(reader, 0);
  if (!reader.atEnd()) throw new Error("trailing bytes after thrift message");
  return {
    method,
    type: messageType,
    seqId,
    fields,
  };
}

function decodeNonStrictMessage(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ThriftBinaryReader(bytes);
  const nameLength = reader.i32();
  if (nameLength <= 0 || nameLength > MAX_METHOD_NAME_LENGTH) {
    throw new Error("invalid thrift method name length");
  }
  const method = decodeUtf8Printable(reader.bytesSlice(nameLength));
  if (!method || !isValidMethodName(method)) {
    throw new Error("invalid thrift method name");
  }
  const messageType = MESSAGE_TYPES[reader.u8()];
  if (!messageType) throw new Error("invalid thrift message type");
  const seqId = reader.i32();
  const fields = readStruct(reader, 0);
  if (!reader.atEnd()) throw new Error("trailing bytes after thrift message");
  return {
    method,
    type: messageType,
    seqId,
    fields,
  };
}

function decodeRawStruct(bytes: Uint8Array, depth = 0): Record<string, unknown> {
  const reader = new ThriftBinaryReader(bytes);
  const fields = readStruct(reader, depth);
  if (!reader.atEnd() || Object.keys(fields).length === 0) {
    throw new Error("invalid thrift struct");
  }
  return fields;
}

function tryDecodeEnveloped(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    return decodeEnveloped(bytes);
  } catch {
    return null;
  }
}

function tryDecodeFramed(bytes: Uint8Array, allowRawStruct: boolean): Record<string, unknown> | null {
  if (bytes.length <= 4) return null;
  const frameLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (frameLength === 0 || frameLength !== bytes.length - 4) return null;
  const inner = bytes.subarray(4);
  return tryDecodeEnveloped(inner) ?? (allowRawStruct ? tryDecodeRawStruct(inner) : null);
}

function tryDecodeRawStruct(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    return decodeRawStruct(bytes);
  } catch {
    return null;
  }
}

export function decodeThriftBinary(bytes: Uint8Array, options: { allowRawStructSniff?: boolean } = {}): ThriftBinaryDecodeResult | null {
  if (bytes.length === 0) return null;
  // Enveloped thrift messages carry an unambiguous header (strict version word
  // or a 0x80 0x01 non-strict marker). A headerless payload only "decoding" as
  // a raw struct is a heuristic that can misfire on arbitrary binary, so it is
  // opt-in (RabbitMQ's payload contract) rather than applied to every MQ kind.
  const enveloped = tryDecodeEnveloped(bytes) ?? tryDecodeFramed(bytes, options.allowRawStructSniff === true);
  if (enveloped) return { formattedText: JSON.stringify(enveloped, null, 2), value: enveloped };
  if (options.allowRawStructSniff !== true) return null;
  const raw = tryDecodeRawStruct(bytes);
  return raw ? { formattedText: JSON.stringify(raw, null, 2), value: raw } : null;
}

function decodeEnveloped(bytes: Uint8Array): Record<string, unknown> {
  const firstWord = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (bytes.length >= 4 && (firstWord & THRIFT_VERSION_MASK) >>> 0 === THRIFT_VERSION_1) {
    return decodeStrictMessage(bytes);
  }
  return decodeNonStrictMessage(bytes);
}

function base64ToBytes(base64: string): Uint8Array | null {
  const normalized = base64.trim();
  if (!normalized) return null;
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function decodeThriftBinaryBase64(base64?: string, options: { allowRawStructSniff?: boolean } = {}): ThriftBinaryDecodeResult | null {
  if (!base64) return null;
  const bytes = base64ToBytes(base64);
  if (!bytes) return null;
  return decodeThriftBinary(bytes, options);
}

export function formatMqMessagePayload(message: Pick<PeekedMessage, "payloadText" | "payloadBase64">, options: { allowRawStructSniff?: boolean } = {}): string {
  if (message.payloadText !== undefined && message.payloadText !== "" && isPrintableText(message.payloadText)) {
    return message.payloadText;
  }
  const decodedFromBase64 = decodeThriftBinaryBase64(message.payloadBase64, options);
  if (decodedFromBase64) {
    return decodedFromBase64.formattedText;
  }
  if (message.payloadText) {
    const decodedFromText = decodeThriftBinary(new TextEncoder().encode(message.payloadText), options);
    if (decodedFromText) {
      return decodedFromText.formattedText;
    }
  }
  return message.payloadText ?? message.payloadBase64;
}

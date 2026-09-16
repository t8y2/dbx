/**
 * Schema-less Protobuf wire-format decoder. Without a .proto file field names
 * are unknown, so fields render keyed by number; nested messages, UTF-8 text,
 * and raw bytes are told apart heuristically. The decode is data-only and is
 * never auto-detected — many arbitrary byte strings parse as valid wire format.
 */
export interface RedisProtobufDetail {
  formattedText: string;
  value: unknown;
}

class ProtobufReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): bigint {
    let shift = 0n;
    let value = 0n;
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 63n) throw new Error("varint too long");
    }
    throw new Error("truncated varint");
  }

  fixed(size: number): Uint8Array {
    if (this.pos + size > this.bytes.length) throw new Error("truncated fixed value");
    const view = this.bytes.subarray(this.pos, this.pos + size);
    this.pos += size;
    return view;
  }

  delimited(): Uint8Array {
    const length = Number(this.varint());
    if (!Number.isSafeInteger(length) || this.pos + length > this.bytes.length) throw new Error("truncated length-delimited value");
    const view = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return view;
  }
}

function decodeMessage(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtobufReader(bytes);
  const fields: Record<string, unknown> = {};
  while (!reader.atEnd()) {
    const tag = reader.varint();
    if (tag > 0xffff_ffffn) throw new Error("field number too large");
    const field = tag >> 3n;
    const wireType = Number(tag & 7n);
    if (field < 1n || wireType > 5 || wireType === 3 || wireType === 4) throw new Error("unsupported wire type");
    let value: unknown;
    if (wireType === 0) {
      const raw = reader.varint();
      value = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw.toString();
    } else if (wireType === 2) {
      value = decodeDelimited(reader.delimited());
    } else {
      value = bytesToHex(reader.fixed(wireType === 1 ? 8 : 4));
    }
    const key = String(field);
    const existing = fields[key];
    if (existing === undefined) fields[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else fields[key] = [existing, value];
  }
  if (Object.keys(fields).length === 0) throw new Error("empty message");
  return fields;
}

function decodeDelimited(bytes: Uint8Array): unknown {
  if (bytes.length > 0) {
    try {
      return decodeMessage(bytes);
    } catch {
      // Not a nested message; fall through to text/bytes rendering.
    }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Embedded controls (other than common whitespace) mean bytes, not text.
    let printable = true;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        printable = false;
        break;
      }
    }
    if (printable) return text;
  } catch {
    // Not valid UTF-8; fall through to bytes rendering.
  }
  return { $bytes: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeProtobuf(bytes: Uint8Array): RedisProtobufDetail | null {
  if (bytes.length === 0) return null;
  try {
    const value = decodeMessage(bytes);
    return { formattedText: JSON.stringify(value, null, 2), value };
  } catch {
    return null;
  }
}

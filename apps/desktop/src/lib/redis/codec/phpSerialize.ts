/**
 * Data-only PHP serialize decoder. `s:<len>` counts bytes, not characters, so
 * the parser walks the raw bytes and only converts complete runs to UTF-8 text.
 */
export interface RedisPhpSerializedDetail {
  formattedText: string;
  value: unknown;
}

const HEADER = /^(?:a|O|b|i|d|s|N)[:;]/;

class PhpUnserializer {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  parse(): unknown {
    const value = this.value();
    if (this.pos !== this.bytes.length) throw new Error("trailing bytes");
    return value;
  }

  private value(): unknown {
    const type = String.fromCharCode(this.bytes[this.pos] ?? 0);
    switch (type) {
      case "N":
        this.expect("N;");
        return null;
      case "b":
        this.expect("b:");
        return this.integer(";") === 1;
      case "i":
        this.expect("i:");
        return this.integer(";");
      case "d":
        this.expect("d:");
        return this.real(";");
      case "s":
        return this.text();
      case "a":
        return this.array();
      case "O":
        return this.object();
      default:
        throw new Error(`unsupported type "${type}"`);
    }
  }

  private literal(token: string): boolean {
    for (let i = 0; i < token.length; i++) {
      if (this.bytes[this.pos + i] !== token.charCodeAt(i)) return false;
    }
    this.pos += token.length;
    return true;
  }

  private integer(terminator: string): number {
    const start = this.pos;
    this.skipUntil(terminator);
    const text = this.decode(start, this.pos);
    if (!/^-?\d+$/.test(text)) throw new Error(`invalid integer "${text}"`);
    this.expect(terminator);
    return Number(text);
  }

  private real(terminator: string): number {
    const start = this.pos;
    this.skipUntil(terminator);
    const text = this.decode(start, this.pos);
    this.expect(terminator);
    if (text === "INF") return Number.POSITIVE_INFINITY;
    if (text === "-INF") return Number.NEGATIVE_INFINITY;
    if (text === "NAN") return Number.NaN;
    if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) throw new Error(`invalid double "${text}"`);
    return Number(text);
  }

  private text(): string {
    if (!this.literal("s:")) throw new Error("expected string header");
    return this.quotedText('";');
  }

  /** `<len>:"<bytes>"` — the shared body of `s:` values and `O:` class names. */
  private quotedText(terminator: string): string {
    const start = this.pos;
    this.skipUntil(":");
    const lengthText = this.decode(start, this.pos);
    if (!/^\d+$/.test(lengthText)) throw new Error(`invalid string length "${lengthText}"`);
    this.expect(":");
    this.expect('"');
    const length = Number(lengthText);
    if (this.pos + length + terminator.length > this.bytes.length) throw new Error("string length overruns payload");
    const text = this.decode(this.pos, this.pos + length);
    this.pos += length;
    if (!this.literal(terminator)) throw new Error("expected string terminator");
    return text;
  }

  private array(): unknown {
    if (!this.literal("a:")) throw new Error("expected array header");
    const length = this.integer(":{");
    const entries = new Map<unknown, unknown>();
    for (let i = 0; i < length; i++) entries.set(this.value(), this.value());
    this.expect("}");
    // Sequential integer keys render as a plain array, everything else as a map.
    let sequential = true;
    let index = 0;
    for (const key of entries.keys()) {
      if (key !== index++) {
        sequential = false;
        break;
      }
    }
    if (!sequential) return Object.fromEntries([...entries].map(([key, value]) => [String(key), value]));
    return [...entries.values()];
  }

  private object(): unknown {
    if (!this.literal("O:")) throw new Error("expected object header");
    const className = this.quotedText('":');
    const length = this.integer(":{");
    const props: Record<string, unknown> = { $class: className };
    for (let i = 0; i < length; i++) {
      const name = this.value();
      if (typeof name !== "string") throw new Error("object property names must be strings");
      props[name] = this.value();
    }
    this.expect("}");
    return props;
  }

  private skipUntil(terminator: string): void {
    const code = terminator.charCodeAt(0);
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== code) this.pos++;
  }

  private expect(token: string): void {
    if (!this.literal(token)) throw new Error(`expected "${token}" at byte ${this.pos}`);
  }

  private decode(start: number, end: number): string {
    return new TextDecoder().decode(this.bytes.subarray(start, end));
  }
}

export function isPhpSerialized(bytes: Uint8Array): boolean {
  return HEADER.test(new TextDecoder().decode(bytes.subarray(0, 2)));
}

export function decodePhpSerialized(bytes: Uint8Array): RedisPhpSerializedDetail | null {
  if (bytes.length === 0 || !isPhpSerialized(bytes)) return null;
  try {
    const value = new PhpUnserializer(bytes).parse();
    return { formattedText: JSON.stringify(value, null, 2), value };
  } catch {
    return null;
  }
}

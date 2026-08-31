export interface RedisPickleDetail {
  formattedText: string;
  value: unknown;
}

const PROTO = 0x80;
const NEWOBJ = 0x81;
const TUPLE1 = 0x85;
const TUPLE2 = 0x86;
const TUPLE3 = 0x87;
const NEWTRUE = 0x88;
const NEWFALSE = 0x89;
const LONG1 = 0x8a;
const LONG4 = 0x8b;
const SHORT_BINUNICODE = 0x8c;
const BINUNICODE8 = 0x8d;
const BINBYTES8 = 0x8e;
const EMPTY_SET = 0x8f;
const ADDITEMS = 0x90;
const FROZENSET = 0x91;
const NEWOBJ_EX = 0x92;
const STACK_GLOBAL = 0x93;
const MEMOIZE = 0x94;
const FRAME = 0x95;
const BYTEARRAY8 = 0x96;
const SHORT_BINBYTES = 0x43;
const BINBYTES = 0x42;
const BININT = 0x4a;
const BININT1 = 0x4b;
const BININT2 = 0x4d;
const BINFLOAT = 0x47;
const BINUNICODE = 0x58;
const BINSTRING = 0x54;
const SHORT_BINSTRING = 0x55;
const BINPUT = 0x71;
const LONG_BINPUT = 0x72;
const BINGET = 0x68;
const LONG_BINGET = 0x6a;
const MARK = 0x28;
const STOP = 0x2e;
const POP = 0x30;
const POP_MARK = 0x31;
const DUP = 0x32;
const EMPTY_TUPLE = 0x29;
const EMPTY_LIST = 0x5d;
const EMPTY_DICT = 0x7d;
const APPEND = 0x61;
const BUILD = 0x62;
const GLOBAL = 0x63;
const DICT = 0x64;
const APPENDS = 0x65;
const GET = 0x67;
const INST = 0x69;
const LIST = 0x6c;
const PUT = 0x70;
const SETITEM = 0x73;
const TUPLE = 0x74;
const SETITEMS = 0x75;
const NONE = 0x4e;
const REDUCE = 0x52;
const FLOAT = 0x46;
const INT = 0x49;
const LONG = 0x4c;
const STRING = 0x53;
const UNICODE = 0x56;
const OBJ = 0x6f;

const MAX_OPS = 1_000_000;

class PickleGlobal {
  constructor(
    readonly module: string,
    readonly name: string,
  ) {}

  get id(): string {
    return `${this.module}.${this.name}`;
  }
}

class PickleInstance {
  state: unknown = null;

  constructor(
    readonly className: string,
    readonly args: unknown,
  ) {}
}

class PickleUnpickler {
  private readonly view: DataView;
  private pos = 0;
  private readonly stack: unknown[] = [];
  private readonly metastack: unknown[][] = [];
  private readonly memo = new Map<number, unknown>();
  private nextMemoId = 0;
  private ops = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  load(): unknown {
    while (this.pos < this.bytes.length) {
      if (++this.ops > MAX_OPS) throw new Error("pickle too complex");
      const opcode = this.readByte();
      if (opcode === STOP) break;
      this.dispatch(opcode);
    }
    if (this.stack.length === 0) throw new Error("empty pickle");
    return this.stack[this.stack.length - 1];
  }

  private dispatch(opcode: number): void {
    switch (opcode) {
      case PROTO:
        if (this.readByte() > 5) throw new Error("unsupported pickle protocol");
        return;
      case FRAME:
        this.read(8);
        return;
      case NONE:
        this.stack.push(null);
        return;
      case NEWTRUE:
        this.stack.push(true);
        return;
      case NEWFALSE:
        this.stack.push(false);
        return;
      case INT:
        this.stack.push(parsePickleInt(this.readLine()));
        return;
      case BININT:
        this.stack.push(this.view.getInt32(this.advance(4), true));
        return;
      case BININT1:
        this.stack.push(this.readByte());
        return;
      case BININT2:
        this.stack.push(this.view.getUint16(this.advance(2), true));
        return;
      case LONG:
        this.stack.push(parsePickleLong(this.readLine()));
        return;
      case LONG1:
        this.stack.push(this.readLong(this.readByte()));
        return;
      case LONG4:
        this.stack.push(this.readLong(this.view.getInt32(this.advance(4), true)));
        return;
      case FLOAT:
        this.stack.push(Number(this.readLine()));
        return;
      case BINFLOAT:
        this.stack.push(this.view.getFloat64(this.advance(8), false));
        return;
      case BINUNICODE:
        this.stack.push(this.readUtf8(this.view.getUint32(this.advance(4), true)));
        return;
      case SHORT_BINUNICODE:
        this.stack.push(this.readUtf8(this.readByte()));
        return;
      case BINUNICODE8:
        this.stack.push(this.readUtf8(this.readUint64()));
        return;
      case UNICODE:
        this.stack.push(decodeUnicodeEscape(this.readLine()));
        return;
      case STRING:
        this.stack.push(parsePickleString(this.readLine()));
        return;
      case BINSTRING:
        this.stack.push(latin1FromBytes(this.read(this.view.getUint32(this.advance(4), true))));
        return;
      case SHORT_BINSTRING:
        this.stack.push(latin1FromBytes(this.read(this.readByte())));
        return;
      case BINBYTES:
        this.stack.push(this.read(this.view.getUint32(this.advance(4), true)));
        return;
      case SHORT_BINBYTES:
        this.stack.push(this.read(this.readByte()));
        return;
      case BINBYTES8:
      case BYTEARRAY8:
        this.stack.push(this.read(this.readUint64()));
        return;
      case EMPTY_LIST:
        this.stack.push([]);
        return;
      case EMPTY_DICT:
        this.stack.push(Object.create(null));
        return;
      case EMPTY_TUPLE:
        this.stack.push([]);
        return;
      case EMPTY_SET:
        this.stack.push([]);
        return;
      case MARK:
        this.metastack.push(this.stack.splice(0, this.stack.length));
        return;
      case POP:
        this.pop();
        return;
      case POP_MARK:
        this.popMark();
        return;
      case DUP:
        this.stack.push(this.stack[this.stack.length - 1]);
        return;
      case APPEND:
        this.appendOne();
        return;
      case APPENDS:
        this.appends();
        return;
      case SETITEM:
        this.setItem();
        return;
      case SETITEMS:
        this.setItems();
        return;
      case ADDITEMS:
        this.addItems();
        return;
      case LIST:
      case TUPLE:
      case FROZENSET:
        this.stack.push(this.popMark());
        return;
      case DICT:
        this.stack.push(pairsToObject(this.popMark()));
        return;
      case TUPLE1:
        this.stack.push([this.pop()]);
        return;
      case TUPLE2: {
        const b = this.pop();
        const a = this.pop();
        this.stack.push([a, b]);
        return;
      }
      case TUPLE3: {
        const c = this.pop();
        const b = this.pop();
        const a = this.pop();
        this.stack.push([a, b, c]);
        return;
      }
      case GLOBAL:
        this.stack.push(new PickleGlobal(this.readLine(), this.readLine()));
        return;
      case STACK_GLOBAL: {
        const name = this.pop();
        const module = this.pop();
        this.stack.push(new PickleGlobal(String(module), String(name)));
        return;
      }
      case REDUCE:
        this.reduce();
        return;
      case NEWOBJ:
        this.newObj(false);
        return;
      case NEWOBJ_EX:
        this.newObj(true);
        return;
      case BUILD:
        this.build();
        return;
      case INST:
        this.stack.push(new PickleInstance(`${this.readLine()}.${this.readLine()}`, this.popMark()));
        return;
      case OBJ: {
        const items = this.popMark();
        const cls = items.shift();
        this.stack.push(new PickleInstance(classNameOf(cls), items));
        return;
      }
      case MEMOIZE:
        this.memo.set(this.nextMemoId++, this.peek());
        return;
      case BINPUT:
        this.memo.set(this.readByte(), this.peek());
        return;
      case LONG_BINPUT:
        this.memo.set(this.view.getUint32(this.advance(4), true), this.peek());
        return;
      case BINGET:
        this.stack.push(this.memoGet(this.readByte()));
        return;
      case LONG_BINGET:
        this.stack.push(this.memoGet(this.view.getUint32(this.advance(4), true)));
        return;
      case PUT:
        this.memo.set(Number(this.readLine()), this.peek());
        return;
      case GET:
        this.stack.push(this.memoGet(Number(this.readLine())));
        return;
      default:
        throw new Error(`unsupported pickle opcode 0x${opcode.toString(16)}`);
    }
  }

  private reduce(): void {
    const args = this.pop();
    const callable = this.pop();
    this.stack.push(applyReduce(callable, Array.isArray(args) ? args : [args]));
  }

  private newObj(withKwargs: boolean): void {
    const kwargs = withKwargs ? this.pop() : undefined;
    const args = this.pop();
    const cls = this.pop();
    const instance = new PickleInstance(classNameOf(cls), Array.isArray(args) ? args : [args]);
    if (kwargs != null) instance.state = kwargs;
    this.stack.push(instance);
  }

  private build(): void {
    const state = this.pop();
    this.stack[this.stack.length - 1] = applyBuild(this.peek(), state);
  }

  private appendOne(): void {
    const value = this.pop();
    const list = this.peek();
    if (!Array.isArray(list)) throw new Error("APPEND on non-list");
    list.push(value);
  }

  private appends(): void {
    const items = this.popMark();
    const list = this.peek();
    if (!Array.isArray(list)) throw new Error("APPENDS on non-list");
    list.push(...items);
  }

  private addItems(): void {
    const items = this.popMark();
    const list = this.peek();
    if (!Array.isArray(list)) throw new Error("ADDITEMS on non-set");
    list.push(...items);
  }

  private setItem(): void {
    const value = this.pop();
    const key = this.pop();
    writeKey(this.peek(), key, value);
  }

  private setItems(): void {
    const items = this.popMark();
    const dict = this.peek();
    for (let i = 0; i + 1 < items.length; i += 2) writeKey(dict, items[i], items[i + 1]);
  }

  private popMark(): unknown[] {
    const items = this.stack.splice(0, this.stack.length);
    const parent = this.metastack.pop();
    if (!parent) throw new Error("MARK underflow");
    this.stack.push(...parent);
    return items;
  }

  private pop(): unknown {
    if (this.stack.length === 0) throw new Error("stack underflow");
    return this.stack.pop();
  }

  private peek(): unknown {
    if (this.stack.length === 0) throw new Error("stack underflow");
    return this.stack[this.stack.length - 1];
  }

  private memoGet(id: number): unknown {
    if (!this.memo.has(id)) throw new Error("missing pickle memo");
    return this.memo.get(id);
  }

  private readByte(): number {
    if (this.pos >= this.bytes.length) throw new Error("unexpected end of pickle");
    return this.bytes[this.pos++];
  }

  private advance(n: number): number {
    const start = this.pos;
    if (start + n > this.bytes.length) throw new Error("unexpected end of pickle");
    this.pos += n;
    return start;
  }

  private read(n: number): Uint8Array {
    const start = this.advance(n);
    return this.bytes.subarray(start, start + n);
  }

  private readUint64(): number {
    const start = this.advance(8);
    const lo = this.view.getUint32(start, true);
    const hi = this.view.getUint32(start + 4, true);
    if (hi > 0x1fffff) throw new Error("pickle length too large");
    return lo + hi * 2 ** 32;
  }

  private readUtf8(n: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.read(n));
  }

  private readLine(): string {
    const start = this.pos;
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a) this.pos++;
    if (this.pos >= this.bytes.length) throw new Error("unterminated pickle line");
    const line = this.bytes.subarray(start, this.pos);
    this.pos++;
    return new TextDecoder("latin1").decode(line);
  }

  private readLong(length: number): number | string {
    if (length < 0) throw new Error("invalid pickle long");
    return decodeTwoComplement(this.read(length));
  }
}

function parsePickleInt(line: string): boolean | number {
  if (line === "01") return true;
  if (line === "00") return false;
  const value = Number(line);
  if (!Number.isFinite(value)) throw new Error("invalid pickle int");
  return value;
}

function parsePickleLong(line: string): number | string {
  const trimmed = line.endsWith("L") ? line.slice(0, -1) : line;
  return bigintToJson(BigInt(trimmed || "0"));
}

function parsePickleString(line: string): string {
  const trimmed = line.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function decodeUnicodeEscape(line: string): string {
  return line.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function classNameOf(value: unknown): string {
  return value instanceof PickleGlobal ? value.id : String(value);
}

function applyReduce(callable: unknown, args: unknown[]): unknown {
  const id = callable instanceof PickleGlobal ? callable.id : "";
  switch (id) {
    case "datetime.datetime":
      return reduceDatetime(args);
    case "datetime.date":
      return reduceDate(args);
    case "datetime.time":
      return reduceTime(args);
    case "_codecs.encode":
      return reduceCodecsEncode(args);
    case "builtins.bytes":
    case "__builtin__.bytes":
    case "builtins.bytearray":
      return reduceBytes(args);
    case "uuid.UUID":
      return new PickleInstance(id, args);
    default:
      return { $class: id || String(callable), $args: toJsonable(args) };
  }
}

function applyBuild(obj: unknown, state: unknown): unknown {
  if (obj instanceof PickleInstance) {
    obj.state = state;
    if (obj.className === "uuid.UUID") return reduceUuidState(state);
    return { $class: obj.className, $args: toJsonable(obj.args), $state: toJsonable(state) };
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj) && state && typeof state === "object" && !Array.isArray(state)) {
    return { ...(obj as object), ...(state as object) };
  }
  return obj;
}

function reduceDatetime(args: unknown[]): string {
  if (args.length === 1 && args[0] instanceof Uint8Array) return datetimeFromPayload(args[0]);
  if (typeof args[0] === "string") return datetimeFromPayload(latin1ToBytes(args[0]));
  const [year, month, day, hour = 0, minute = 0, second = 0, micro = 0] = args.map((value) => Number(value));
  return formatDatetime(year, month, day, hour, minute, second, micro);
}

function reduceDate(args: unknown[]): string {
  const [year, month, day] = args.map((value) => Number(value));
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function reduceTime(args: unknown[]): string {
  const [hour = 0, minute = 0, second = 0, micro = 0] = args.map((value) => Number(value));
  return formatTime(hour, minute, second, micro);
}

function reduceCodecsEncode(args: unknown[]): unknown {
  const [data, encoding] = args;
  if (typeof data === "string" && encoding === "latin1") return latin1ToBytes(data);
  return { $class: "_codecs.encode", $args: toJsonable(args) };
}

function reduceBytes(args: unknown[]): unknown {
  if (args.length === 1 && args[0] instanceof Uint8Array) return args[0];
  if (args.length === 1 && typeof args[0] === "string") return latin1ToBytes(args[0]);
  return { $class: "bytes", $args: toJsonable(args) };
}

function reduceUuidState(state: unknown): unknown {
  if (!state || typeof state !== "object") return { $class: "uuid.UUID", $state: toJsonable(state) };
  const record = state as Record<string, unknown>;
  if (record.int != null) return uuidFromInt(toBigInt(record.int));
  if (typeof record.hex === "string") return normalizeUuid(record.hex);
  return { $class: "uuid.UUID", $state: toJsonable(state) };
}

function datetimeFromPayload(bytes: Uint8Array): string {
  if (bytes.length !== 10) throw new Error("invalid datetime payload");
  const year = (bytes[0] << 8) | bytes[1];
  const micro = (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];
  return formatDatetime(year, bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], micro);
}

function formatDatetime(year: number, month: number, day: number, hour: number, minute: number, second: number, micro: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${formatTime(hour, minute, second, micro)}`;
}

function formatTime(hour: number, minute: number, second: number, micro: number): string {
  const base = `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
  return micro ? `${base}.${pad(micro, 6)}` : base;
}

function pad(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, "0");
}

function uuidFromInt(value: bigint): string {
  return normalizeUuid(value.toString(16).padStart(32, "0"));
}

function normalizeUuid(hex: string): string {
  const digits = hex.replace(/-/g, "").padStart(32, "0").slice(-32);
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`;
}

function writeKey(dict: unknown, key: unknown, value: unknown): void {
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) throw new Error("SETITEM on non-dict");
  (dict as Record<string, unknown>)[keyToString(key)] = value;
}

function pairsToObject(items: unknown[]): Record<string, unknown> {
  const dict = Object.create(null) as Record<string, unknown>;
  for (let i = 0; i + 1 < items.length; i += 2) dict[keyToString(items[i])] = items[i + 1];
  return dict;
}

function keyToString(key: unknown): string {
  if (typeof key === "string") return key;
  if (typeof key === "number" || typeof key === "boolean") return String(key);
  return JSON.stringify(toJsonable(key)) ?? String(key);
}

function latin1FromBytes(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

function decodeTwoComplement(bytes: Uint8Array): number | string {
  if (bytes.length === 0) return 0;
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  const bits = BigInt(bytes.length * 8);
  if (bytes[bytes.length - 1] & 0x80) value -= 1n << bits;
  return bigintToJson(value);
}

function bigintToJson(value: bigint): number | string {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  return value.toString();
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  throw new Error("invalid uuid int");
}

export function toJsonable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return { $bytes: bytesToBase64(value) };
    }
  }
  if (value instanceof PickleGlobal) return { $class: value.id };
  if (value instanceof PickleInstance) {
    return { $class: value.className, $args: toJsonable(value.args, seen), $state: toJsonable(value.state, seen) };
  }
  if (Array.isArray(value)) return value.map((item) => toJsonable(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return { $ref: true };
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = toJsonable(item, seen);
    return output;
  }
  if (typeof value === "bigint") return bigintToJson(value);
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function isPickleMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === PROTO && bytes[1] <= 5 && bytes[bytes.length - 1] === STOP;
}

export function decodePickle(bytes: Uint8Array): RedisPickleDetail | null {
  try {
    const value = toJsonable(new PickleUnpickler(bytes).load());
    return {
      value,
      formattedText: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    };
  } catch {
    return null;
  }
}

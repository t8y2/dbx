export interface RedisJavaSerializedDetail {
  formattedText: string;
  value: unknown;
}

type JavaFieldDescriptor = {
  type: string;
  name: string;
  className?: string;
};

type JavaClassDescriptor = {
  name: string;
  serialVersionUID: string;
  flags: number;
  isEnum: boolean;
  fields: JavaFieldDescriptor[];
  superClass: JavaClassDescriptor | null;
};

type JavaObjectValue = Record<string, unknown> & {
  [JAVA_CLASS_META]?: JavaClassDescriptor;
  [JAVA_EXTENDS_META]?: Record<string, Record<string, unknown>>;
};

type JavaPostProcessor = (fields: Record<string, unknown>, annotations: unknown[]) => Record<string, unknown>;

const JAVA_CLASS_META = Symbol("javaClassMeta");
const JAVA_EXTENDS_META = Symbol("javaExtendsMeta");
const STREAM_MAGIC = 0xaced;
const STREAM_VERSION = 5;
const BASE_WIRE_HANDLE = 0x7e0000;
const END_BLOCK = Symbol("endBlock");

const TAG_NAMES: Record<number, string> = {
  0x70: "Null",
  0x71: "Reference",
  0x72: "ClassDesc",
  0x73: "Object",
  0x74: "String",
  0x75: "Array",
  0x76: "Class",
  0x77: "BlockData",
  0x78: "EndBlockData",
  0x79: "Reset",
  0x7a: "BlockDataLong",
  0x7b: "Exception",
  0x7c: "LongString",
  0x7d: "ProxyClassDesc",
  0x7e: "Enum",
};

const JAVA_POST_PROCESSORS = new Map<string, JavaPostProcessor>([
  ["java.util.ArrayList@7881d21d99c7619d", (fields, annotations) => ({ ...fields, list: annotations.slice(1) })],
  ["java.util.ArrayDeque@207cda2e240da08b", (fields, annotations) => ({ ...fields, list: annotations.slice(1) })],
  ["java.util.Hashtable@13bb0f25214ae4b8", mapPostProcessor],
  ["java.util.HashMap@0507dac1c31660d1", mapPostProcessor],
  ["java.util.HashMap@0507b0c1331660d1", mapPostProcessor],
  ["java.util.EnumMap@065d7df7be907ca1", enumMapPostProcessor],
  ["java.util.HashSet@ba44859596b8b734", hashSetPostProcessor],
]);

export function parseJavaSerializedDetail(bytes: Uint8Array): RedisJavaSerializedDetail | null {
  if (!isJavaSerialized(bytes)) return null;

  try {
    const parser = new JavaSerializationParser(bytes);
    const contents = parser.parseContents();
    if (contents.length === 0) return null;
    const root = contents.length === 1 ? contents[0] : contents;
    const normalized = normalizeJavaSerializedValue(root, new WeakMap<object, string>(), { nextId: 1 });
    return {
      value: normalized,
      formattedText: JSON.stringify(normalized, null, 2),
    };
  } catch {
    return null;
  }
}

export function isJavaSerialized(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xac && bytes[1] === 0xed && bytes[2] === 0x00 && bytes[3] === 0x05;
}

class JavaSerializationParser {
  private readonly view: DataView;
  private position = 0;
  private nextHandle = BASE_WIRE_HANDLE;
  private readonly handles = new Map<number, unknown>();

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  parseContents(): unknown[] {
    if (this.readUint16() !== STREAM_MAGIC) throw new Error("STREAM_MAGIC not found");
    if (this.readUint16() !== STREAM_VERSION) throw new Error("Only understand protocol version 5");

    const contents: unknown[] = [];
    while (this.position < this.bytes.length) {
      contents.push(this.readContent());
    }
    return contents;
  }

  private readContent(allowed?: string[]): unknown {
    const tag = this.readUint8();
    const name = TAG_NAMES[tag];
    if (!name) throw new Error(`Don't know about type 0x${tag.toString(16)}`);
    if (allowed && !allowed.includes(name)) throw new Error(`${name} not allowed here`);

    switch (tag) {
      case 0x70:
        return null;
      case 0x71:
        return this.readReference();
      case 0x72:
        return this.readClassDescriptor();
      case 0x73:
        return this.readObject();
      case 0x74:
        return this.addHandle(this.readUtf());
      case 0x75:
        return this.readArray();
      case 0x76:
        return this.addHandle(this.readClassDesc());
      case 0x77:
        return this.readBytes(this.readUint8());
      case 0x78:
        return END_BLOCK;
      case 0x79:
      case 0x7b:
      case 0x7d:
        throw new Error(`Don't know how to handle ${name}`);
      case 0x7a:
        return this.readBytes(this.readUint32());
      case 0x7c:
        return this.addHandle(this.readUtfLong());
      case 0x7e:
        return this.readEnum();
      default:
        throw new Error(`Don't know how to handle ${name}`);
    }
  }

  private readClassDesc(): JavaClassDescriptor | null {
    return this.readContent(["ClassDesc", "ProxyClassDesc", "Null", "Reference"]) as JavaClassDescriptor | null;
  }

  private readClassDescriptor(): JavaClassDescriptor {
    const descriptor: JavaClassDescriptor = {
      name: this.readUtf(),
      serialVersionUID: bytesToHex(this.readBytes(8)),
      flags: 0,
      isEnum: false,
      fields: [],
      superClass: null,
    };
    this.addHandle(descriptor);

    descriptor.flags = this.readUint8();
    descriptor.isEnum = Boolean(descriptor.flags & 0x10);
    const count = this.readUint16();
    for (let index = 0; index < count; index += 1) {
      descriptor.fields.push(this.readFieldDescriptor());
    }
    this.readAnnotations();
    descriptor.superClass = this.readClassDesc();
    return descriptor;
  }

  private readFieldDescriptor(): JavaFieldDescriptor {
    const type = String.fromCharCode(this.readUint8());
    const field: JavaFieldDescriptor = { type, name: this.readUtf() };
    if (type === "[" || type === "L") {
      const className = this.readContent();
      field.className = typeof className === "string" ? className : String(className ?? "");
    }
    return field;
  }

  private readObject(): JavaObjectValue {
    const classDescriptor = this.readClassDesc();
    if (!classDescriptor) throw new Error("Object must have a class descriptor");

    const value: JavaObjectValue = {};
    Object.defineProperty(value, JAVA_CLASS_META, { value: classDescriptor, configurable: true });
    Object.defineProperty(value, JAVA_EXTENDS_META, { value: {}, configurable: true });
    this.addHandle(value);
    this.readClassDataRecursive(classDescriptor, value);
    return value;
  }

  private readClassDataRecursive(classDescriptor: JavaClassDescriptor, value: JavaObjectValue) {
    if (classDescriptor.superClass) {
      this.readClassDataRecursive(classDescriptor.superClass, value);
    }

    const fields = this.readClassData(classDescriptor);
    value[JAVA_EXTENDS_META]![classDescriptor.name] = fields;
    for (const [name, fieldValue] of Object.entries(fields)) {
      value[name] = fieldValue;
    }
  }

  private readClassData(classDescriptor: JavaClassDescriptor): Record<string, unknown> {
    const flags = classDescriptor.flags & 0x0f;
    const postProcessor = JAVA_POST_PROCESSORS.get(`${classDescriptor.name}@${classDescriptor.serialVersionUID}`);

    if (flags === 0x02) return this.readFieldValues(classDescriptor);
    if (flags === 0x03) {
      const fields = this.readFieldValues(classDescriptor);
      const annotations = this.readAnnotations();
      fields["@"] = annotations;
      return postProcessor ? postProcessor(fields, annotations) : fields;
    }
    if (flags === 0x04) throw new Error("Can't parse version 1 external content");
    if (flags === 0x0c) {
      const annotations = this.readAnnotations();
      return { "@": annotations };
    }
    throw new Error(`Don't know how to deserialize class with flags 0x${classDescriptor.flags.toString(16)}`);
  }

  private readArray(): unknown[] {
    const classDescriptor = this.readClassDesc();
    if (!classDescriptor) throw new Error("Array must have a class descriptor");

    const value: unknown[] = [];
    Object.defineProperty(value, JAVA_CLASS_META, { value: classDescriptor, configurable: true });
    this.addHandle(value);

    const length = this.readInt32();
    const reader = this.primitiveReader(classDescriptor.name.charAt(1));
    for (let index = 0; index < length; index += 1) {
      value.push(reader());
    }
    return value;
  }

  private readEnum(): unknown {
    const classDescriptor = this.readClassDesc();
    if (!classDescriptor) throw new Error("Enum must have a class descriptor");

    const assignHandle = this.reserveHandle();
    const constant = this.readContent();
    const value = new String(typeof constant === "string" ? constant : String(constant ?? ""));
    Object.defineProperty(value, JAVA_CLASS_META, { value: classDescriptor, configurable: true });
    assignHandle(value);
    return value;
  }

  private readAnnotations(): unknown[] {
    const annotations: unknown[] = [];
    while (true) {
      const value = this.readContent();
      if (value === END_BLOCK) return annotations;
      annotations.push(value);
    }
  }

  private readFieldValues(classDescriptor: JavaClassDescriptor): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const field of classDescriptor.fields) {
      values[field.name] = this.primitiveReader(field.type)();
    }
    return values;
  }

  private primitiveReader(type: string): () => unknown {
    switch (type) {
      case "B":
        return () => this.readInt8();
      case "C":
        return () => String.fromCharCode(this.readUint16());
      case "D":
        return () => this.readFloat64();
      case "F":
        return () => this.readFloat32();
      case "I":
        return () => this.readInt32();
      case "J":
        return () => this.readInt64();
      case "S":
        return () => this.readInt16();
      case "Z":
        return () => this.readInt8() !== 0;
      case "L":
      case "[":
        return () => this.readContent();
      default:
        throw new Error(`Don't know how to read field of type '${type}'`);
    }
  }

  private addHandle<T>(value: T): T {
    this.handles.set(this.nextHandle, value);
    this.nextHandle += 1;
    return value;
  }

  private reserveHandle(): (value: unknown) => void {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.handles.set(handle, null);
    return (value: unknown) => {
      this.handles.set(handle, value);
    };
  }

  private readReference(): unknown {
    const handle = this.readInt32();
    if (!this.handles.has(handle)) throw new Error(`Unknown reference handle 0x${handle.toString(16)}`);
    return this.handles.get(handle);
  }

  private readUint8(): number {
    const position = this.step(1);
    return this.view.getUint8(position);
  }

  private readInt8(): number {
    const position = this.step(1);
    return this.view.getInt8(position);
  }

  private readUint16(): number {
    const position = this.step(2);
    return this.view.getUint16(position, false);
  }

  private readInt16(): number {
    const position = this.step(2);
    return this.view.getInt16(position, false);
  }

  private readUint32(): number {
    const position = this.step(4);
    return this.view.getUint32(position, false);
  }

  private readInt32(): number {
    const position = this.step(4);
    return this.view.getInt32(position, false);
  }

  private readInt64(): bigint {
    const high = this.readUint32();
    const low = this.readUint32();
    let value = (BigInt(high) << 32n) | BigInt(low);
    if (high & 0x80000000) {
      value -= 1n << 64n;
    }
    return value;
  }

  private readFloat32(): number {
    const position = this.step(4);
    return this.view.getFloat32(position, false);
  }

  private readFloat64(): number {
    const position = this.step(8);
    return this.view.getFloat64(position, false);
  }

  private readUtf(): string {
    return decodeModifiedUtf8(this.readBytes(this.readUint16()));
  }

  private readUtfLong(): string {
    const high = this.readUint32();
    if (high !== 0) throw new Error("Can't handle more than 2^32 bytes in a string");
    return decodeModifiedUtf8(this.readBytes(this.readUint32()));
  }

  private readBytes(length: number): Uint8Array {
    const position = this.step(length);
    return this.bytes.slice(position, position + length);
  }

  private step(length: number): number {
    const position = this.position;
    this.position += length;
    if (this.position > this.bytes.length) {
      throw new Error("Premature end of input");
    }
    return position;
  }
}

function normalizeJavaSerializedValue(value: unknown, seen: WeakMap<object, string>, state: { nextId: number }): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return { $blockDataHex: bytesToHex(value) };
  }
  if (value instanceof String) {
    const classDescriptor = getJavaClassDescriptor(value);
    if (!classDescriptor) return value.toString();
    return {
      $class: classDescriptor.name,
      $enum: value.toString(),
    };
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return { $ref: seen.get(value) };
  }

  const objectId = `#${state.nextId}`;
  state.nextId += 1;
  seen.set(value, objectId);

  const classDescriptor = getJavaClassDescriptor(value);
  const extendsValues = getJavaExtendsValues(value);

  if (value instanceof Map) {
    return {
      $id: objectId,
      ...(classDescriptor ? { $class: classDescriptor.name } : {}),
      $entries: Array.from(value.entries(), ([key, entryValue]) => ({
        key: normalizeJavaSerializedValue(key, seen, state),
        value: normalizeJavaSerializedValue(entryValue, seen, state),
      })),
    };
  }

  if (value instanceof Set) {
    return {
      $id: objectId,
      ...(classDescriptor ? { $class: classDescriptor.name } : {}),
      $values: Array.from(value.values(), (entryValue) => normalizeJavaSerializedValue(entryValue, seen, state)),
    };
  }

  if (Array.isArray(value)) {
    const normalized = {
      $id: objectId,
      ...(classDescriptor ? { $class: classDescriptor.name } : {}),
      $values: value.map((entryValue) => normalizeJavaSerializedValue(entryValue, seen, state)),
    };
    return normalized;
  }

  const normalized: Record<string, unknown> = {
    $id: objectId,
    ...(classDescriptor ? { $class: classDescriptor.name } : {}),
  };

  for (const [name, entryValue] of Object.entries(value as Record<string, unknown>)) {
    normalized[name] = normalizeJavaSerializedValue(entryValue, seen, state);
  }

  if (extendsValues) {
    const classNames = Object.keys(extendsValues);
    if (classNames.length > 1) {
      normalized.$extends = Object.fromEntries(classNames.map((className) => [className, Object.fromEntries(Object.entries(extendsValues[className]).map(([name, entryValue]) => [name, normalizeJavaSerializedValue(entryValue, seen, state)]))]));
    }
  }

  return normalized;
}

function getJavaClassDescriptor(value: object): JavaClassDescriptor | undefined {
  return (value as { [JAVA_CLASS_META]?: JavaClassDescriptor })[JAVA_CLASS_META];
}

function getJavaExtendsValues(value: object): Record<string, Record<string, unknown>> | undefined {
  return (value as { [JAVA_EXTENDS_META]?: Record<string, Record<string, unknown>> })[JAVA_EXTENDS_META];
}

function mapPostProcessor(fields: Record<string, unknown>, annotations: unknown[]): Record<string, unknown> {
  const header = annotations[0];
  if (!(header instanceof Uint8Array)) return fields;

  const size = readInt32FromBytes(header, 4);
  const map = new Map<unknown, unknown>();
  const obj: Record<string, unknown> = {};
  for (let index = 0; index < size; index += 1) {
    const key = annotations[2 * index + 1];
    const value = annotations[2 * index + 2];
    map.set(key, value);
    if (typeof key === "string") {
      obj[key] = value;
    }
  }
  return { ...fields, map, obj };
}

function enumMapPostProcessor(fields: Record<string, unknown>, annotations: unknown[]): Record<string, unknown> {
  const header = annotations[0];
  if (!(header instanceof Uint8Array)) return fields;

  const size = readInt32FromBytes(header, 0);
  const map = new Map<unknown, unknown>();
  const obj: Record<string, unknown> = {};
  for (let index = 0; index < size; index += 1) {
    const key = annotations[2 * index + 1];
    const value = annotations[2 * index + 2];
    map.set(key, value);
    obj[String(key)] = value;
  }
  return { ...fields, map, obj };
}

function hashSetPostProcessor(fields: Record<string, unknown>, annotations: unknown[]): Record<string, unknown> {
  const header = annotations[0];
  if (!(header instanceof Uint8Array)) return fields;

  const size = readInt32FromBytes(header, 8);
  const values = annotations.slice(1);
  if (values.length !== size) return fields;
  return { ...fields, set: new Set(values) };
}

function readInt32FromBytes(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt32(offset, false);
}

function decodeModifiedUtf8(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index];
    if ((byte & 0x80) === 0) {
      output += String.fromCharCode(byte);
      index += 1;
      continue;
    }
    if ((byte & 0xe0) === 0xc0) {
      const next = bytes[index + 1];
      if (next == null) throw new Error("Invalid modified UTF-8 sequence");
      output += String.fromCharCode(((byte & 0x1f) << 6) | (next & 0x3f));
      index += 2;
      continue;
    }
    if ((byte & 0xf0) === 0xe0) {
      const next = bytes[index + 1];
      const third = bytes[index + 2];
      if (next == null || third == null) throw new Error("Invalid modified UTF-8 sequence");
      output += String.fromCharCode(((byte & 0x0f) << 12) | ((next & 0x3f) << 6) | (third & 0x3f));
      index += 3;
      continue;
    }
    throw new Error("Invalid modified UTF-8 sequence");
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

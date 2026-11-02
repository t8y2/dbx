import { isProxy, toRaw } from "vue";

export const MAX_PLUGIN_WORKBENCH_CONTEXT_BYTES = 2 * 1024 * 1024;

export function clonePluginData<T>(value: T): T {
  const unwrapped = unwrapVueProxies(value);
  try {
    if (typeof structuredClone === "function") return structuredClone(unwrapped);
    return JSON.parse(JSON.stringify(unwrapped)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plugin data cannot be cloned: ${message}`);
  }
}

export function snapshotPluginWorkbenchContext<T extends object>(value: T): T {
  const snapshot = snapshotValue(value, "context", new WeakSet<object>());
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new Error("Plugin workbench context must be an object");
  }
  const size = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (size > MAX_PLUGIN_WORKBENCH_CONTEXT_BYTES) {
    throw new Error(`Plugin workbench context exceeds ${MAX_PLUGIN_WORKBENCH_CONTEXT_BYTES} bytes`);
  }
  return snapshot as T;
}

type PluginContextValue = boolean | number | string | null | PluginContextValue[] | { [key: string]: PluginContextValue } | undefined;

function snapshotValue(value: unknown, path: string, ancestors: WeakSet<object>): PluginContextValue {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`Plugin workbench context contains a non-finite number at ${path}`);
  }
  if (typeof value !== "object") throw new Error(`Plugin workbench context contains an unsupported value at ${path}`);

  const raw = isProxy(value) ? toRaw(value) : value;
  if (ancestors.has(raw)) throw new Error(`Plugin workbench context contains a circular reference at ${path}`);
  const prototype = Object.getPrototypeOf(raw);
  if (!Array.isArray(raw) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Plugin workbench context requires plain data at ${path}`);
  }

  ancestors.add(raw);
  try {
    if (Array.isArray(raw)) {
      return raw.map((item, index) => snapshotValue(item, `${path}[${index}]`, ancestors) ?? null);
    }
    const result: { [key: string]: PluginContextValue } = {};
    for (const [key, item] of Object.entries(raw)) {
      const snapshot = snapshotValue(item, `${path}.${key}`, ancestors);
      if (snapshot !== undefined) result[key] = snapshot;
    }
    return result;
  } finally {
    ancestors.delete(raw);
  }
}

function unwrapVueProxies<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  const rawValue = isProxy(value) ? toRaw(value) : value;
  if (!rawValue || typeof rawValue !== "object") return rawValue;

  const object = rawValue as object;
  const existing = seen.get(object);
  if (existing) return existing as T;
  if (rawValue instanceof Date || rawValue instanceof RegExp || rawValue instanceof ArrayBuffer || ArrayBuffer.isView(rawValue)) {
    return rawValue;
  }
  if (Array.isArray(rawValue)) {
    const result: unknown[] = [];
    seen.set(object, result);
    rawValue.forEach((item, index) => {
      result[index] = unwrapVueProxies(item, seen);
    });
    return result as T;
  }
  if (rawValue instanceof Map) {
    const result = new Map<unknown, unknown>();
    seen.set(object, result);
    rawValue.forEach((item, key) => result.set(unwrapVueProxies(key, seen), unwrapVueProxies(item, seen)));
    return result as T;
  }
  if (rawValue instanceof Set) {
    const result = new Set<unknown>();
    seen.set(object, result);
    rawValue.forEach((item) => result.add(unwrapVueProxies(item, seen)));
    return result as T;
  }
  const prototype = Object.getPrototypeOf(rawValue);
  if (prototype !== Object.prototype && prototype !== null) return rawValue;

  const result = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(object, result);
  for (const key of Reflect.ownKeys(rawValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(rawValue, key);
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(result, key, { ...descriptor, value: unwrapVueProxies(descriptor.value, seen) });
  }
  return result as T;
}

// Loaded as text inside an opaque-origin sandbox, never in the application's realm.
const pending = new Map();
let sequence = 0;
// Validate in the user's realm before structured clone can erase accessors or
// prototypes. The host independently validates again before JSON serialization.
function assertJson(input) {
  const ancestors = new Set();
  let nodes = 0;
  let characters = 0;
  function visit(value, depth) {
    if (++nodes > 100000 || depth > 64) throw new Error("Script request exceeds JSON depth/node limits");
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 2 * 1024 * 1024) throw new Error("Script request exceeds 2 MiB");
      return;
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw new Error("Use Extended JSON for non-finite or unsafe numeric values");
      return;
    }
    if (typeof value !== "object") throw new Error("Script database arguments must be JSON; use Extended JSON for BSON values");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Error("Script database arguments must be plain JSON; Date, RegExp, Map and Set require Extended JSON");
    if (ancestors.has(value)) throw new Error("Script database arguments cannot contain circular references");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (array && (value.length > 100000 || keys.length !== value.length + 1)) throw new Error("Sparse or decorated arrays are not JSON");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw new Error("Symbol properties are not JSON");
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Decorated arrays are not JSON");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property.enumerable || !("value" in property)) throw new Error("Hidden properties and accessors are not JSON");
      characters += key.length;
      if (characters > 2 * 1024 * 1024) throw new Error("Script request exceeds 2 MiB");
      visit(property.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, 0);
}
function rpc(method, collection, args) {
  const id = ++sequence;
  if (id > 1000) return Promise.reject(new Error("Script database call limit (1000) reached"));
  return new Promise((resolve, reject) => {
    assertJson({ id, method, collection, args });
    pending.set(id, { resolve, reject });
    postMessage({ type: "rpc", request: { id, method, collection, args } });
  });
}
function collection(name) {
  function cursor(method, args) {
    const options = { limit: 100, skip: 0, sort: {} };
    const read = () => (method === "find" ? rpc(method, name, [args[0], args[1], options]) : rpc(method, name, [args[0], options.limit]));
    return Object.freeze({
      limit(n) {
        options.limit = n;
        return this;
      },
      skip(n) {
        if (method !== "find") throw new Error("Use $skip in the pipeline");
        options.skip = n;
        return this;
      },
      sort(value) {
        if (method !== "find") throw new Error("Use $sort in the pipeline");
        options.sort = value;
        return this;
      },
      toArray: read,
      async forEach(callback) {
        for (const doc of await read()) await callback(doc);
      },
      async *[Symbol.asyncIterator]() {
        for (const doc of await read()) yield doc;
      },
    });
  }
  return Object.freeze({
    find(filter = {}, projection = {}) {
      return cursor("find", [filter, projection]);
    },
    async findOne(filter = {}, projection = {}) {
      return (await cursor("find", [filter, projection]).limit(1).toArray())[0] ?? null;
    },
    aggregate(pipeline) {
      return cursor("aggregate", [pipeline]);
    },
    countDocuments(filter = {}) {
      return rpc("countDocuments", name, [filter]);
    },
    insertOne(doc) {
      return rpc("insertOne", name, [doc]);
    },
    insertMany(docs) {
      return rpc("insertMany", name, [docs]);
    },
    updateOne(filter, update, options = {}) {
      return rpc("updateOne", name, [filter, update, options]);
    },
    updateMany(filter, update, options = {}) {
      return rpc("updateMany", name, [filter, update, options]);
    },
    replaceOne(filter, doc, options = {}) {
      return rpc("replaceOne", name, [filter, doc, options]);
    },
    deleteOne(filter) {
      return rpc("deleteOne", name, [filter]);
    },
    deleteMany(filter) {
      return rpc("deleteMany", name, [filter]);
    },
  });
}
const print = (...values) => postMessage({ type: "log", values });
const db = new Proxy(Object.freeze({ getCollection: collection }), {
  get(_target, name) {
    return name === "getCollection" ? collection : typeof name === "string" ? collection(name) : undefined;
  },
});
const ObjectId = (value) => {
  if (!/^[0-9a-f]{24}$/i.test(value)) throw new Error("ObjectId requires 24 hexadecimal characters");
  return { $oid: value.toLowerCase() };
};
const ISODate = (value) => ({ $date: new Date(value).toISOString() });
const NumberLong = (value) => {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("NumberLong requires a safe integer or a decimal string");
  if (typeof value !== "number" && typeof value !== "bigint" && (typeof value !== "string" || !/^-?[0-9]+$/.test(value)))
    throw new Error("NumberLong requires an integer or a decimal string");
  const n = BigInt(value);
  if (n < -9223372036854775808n || n > 9223372036854775807n) throw new Error("Int64 out of range");
  return { $numberLong: String(n) };
};
let started = false;
self.onmessage = async ({ data }) => {
  if (data.type === "response") {
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data.value);
  } else if (data.type === "start" && !started) {
    started = true;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const run = new AsyncFunction("db", "print", "printjson", "console", "ObjectId", "ISODate", "NumberLong", '"use strict";\n' + data.source);
      const value = await run(db, print, print, Object.freeze({ log: print, info: print, warn: print, error: print }), ObjectId, ISODate, NumberLong);
      postMessage({ type: "done", value: value === undefined ? null : value });
    } catch (error) {
      postMessage({ type: "error", message: String(error) });
    }
  }
};

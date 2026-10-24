// mongo shell compatibility layer evaluated inside the embedded QuickJS runtime.
// Every `db.*` call is serialised to mongo shell source text and handed to the
// host, which parses it with the same parser as the plain command path, so
// safety checks and driver behaviour are shared.
//
// Values travel as canonical Extended JSON in both directions, so a document
// that is read and written back keeps its BSON types.
(function (g) {
  "use strict";

  // Host hooks are captured here and removed from the global object, so the
  // user's script can neither call nor replace them.
  var exec = g.__dbx_exec;
  var MAX_OUTPUT_LINES = g.__DBX_MAX_OUTPUT_LINES || 10000;
  var MAX_OUTPUT_BYTES = g.__DBX_MAX_OUTPUT_BYTES || 4194304;
  delete g.__dbx_exec;
  delete g.__DBX_MAX_OUTPUT_LINES;
  delete g.__DBX_MAX_OUTPUT_BYTES;

  var out = [];
  var outBytes = 0;
  var outTruncated = false;
  // Set while the completion value is rendered: reads may then be cut to the row limit.
  var displaying = false;
  var valueTruncated = false;

  function utf8Bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  // print() never throws: once the output budget is spent, further lines are dropped.
  function emit(line) {
    if (outTruncated) return;
    var bytes = utf8Bytes(line);
    if (out.length >= MAX_OUTPUT_LINES || outBytes + bytes > MAX_OUTPUT_BYTES) {
      outTruncated = true;
      return;
    }
    out.push(line);
    outBytes += bytes;
  }

  function unsupported(name) {
    return function () {
      throw new Error(name + "() is not supported in DBX MongoDB scripts. Run it as a separate command instead.");
    };
  }

  function hex(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function ObjectId(h) {
    if (!(this instanceof ObjectId)) return new ObjectId(h);
    if (h === undefined) {
      var t = Math.floor(Date.now() / 1000).toString(16);
      while (t.length < 8) t = "0" + t;
      h = t + hex(16);
    }
    this.str = String(h);
  }
  ObjectId.prototype.toString = function () { return 'ObjectId("' + this.str + '")'; };
  ObjectId.prototype.valueOf = function () { return this.str; };
  ObjectId.prototype.toHexString = function () { return this.str; };
  ObjectId.prototype.equals = function (o) { return !!o && String(o.str) === this.str; };
  ObjectId.prototype.getTimestamp = function () { return new Date(parseInt(this.str.substr(0, 8), 16) * 1000); };
  ObjectId.prototype.toJSON = function () { return { $oid: this.str }; };

  function wrapper(tag, key) {
    function W(v) {
      if (!(this instanceof W)) return new W(v);
      this.value = String(v);
    }
    W.prototype.toString = function () { return tag + '("' + this.value + '")'; };
    W.prototype.valueOf = function () { return key === "$numberDecimal" ? this.value : Number(this.value); };
    W.prototype.toNumber = function () { return Number(this.value); };
    W.prototype.toJSON = function () { var o = {}; o[key] = this.value; return o; };
    return W;
  }
  var NumberLong = wrapper("NumberLong", "$numberLong");
  var NumberInt = wrapper("NumberInt", "$numberInt");
  var NumberDecimal = wrapper("NumberDecimal", "$numberDecimal");

  function UUID(s) {
    if (!(this instanceof UUID)) return new UUID(s);
    this.value = String(s);
  }
  UUID.prototype.toString = function () { return 'UUID("' + this.value + '")'; };
  UUID.prototype.toJSON = function () { return { $uuid: this.value }; };

  function Timestamp(t, i) {
    if (!(this instanceof Timestamp)) return new Timestamp(t, i);
    this.t = t;
    this.i = i;
  }
  Timestamp.prototype.toJSON = function () { return { $timestamp: { t: this.t, i: this.i } }; };

  function BinData(subType, base64) {
    if (!(this instanceof BinData)) return new BinData(subType, base64);
    var st = Number(subType).toString(16);
    this.subType = st.length < 2 ? "0" + st : st;
    this.base64 = String(base64);
  }
  BinData.prototype.toJSON = function () { return { $binary: { base64: this.base64, subType: this.subType } }; };

  function ISODate(s) { return s === undefined ? new Date() : new Date(s); }

  var EJSON_KEYS = {
    $oid: 1, $date: 1, $numberInt: 1, $numberLong: 1, $numberDouble: 1, $numberDecimal: 1, $binary: 1,
    $regularExpression: 1, $timestamp: 1, $minKey: 1, $maxKey: 1, $undefined: 1, $symbol: 1, $code: 1,
    $dbPointer: 1, $uuid: 1,
  };
  // An Extended JSON value the layer does not model ($binary, $timestamp, ...): kept verbatim.
  function isEjsonValue(o) {
    var ks = Object.keys(o);
    return (ks.length === 1 && EJSON_KEYS[ks[0]] === 1) || (ks.length === 2 && "$code" in o && "$scope" in o);
  }

  function regexJson(o) {
    return { $regularExpression: { pattern: o.source, options: o.flags.replace(/[^imsx]/g, "").split("").sort().join("") } };
  }

  // Canonical Extended JSON for values sent to the server (filters, documents, updates,
  // pipelines): integers in the int32 range become Int32 like in mongosh, other integers
  // Int64, fractions Double.
  function wire(v) {
    if (v === null) return "null";
    switch (typeof v) {
      case "number":
        if (v !== v) return '{"$numberDouble":"NaN"}';
        if (v === Infinity) return '{"$numberDouble":"Infinity"}';
        if (v === -Infinity) return '{"$numberDouble":"-Infinity"}';
        if (Math.floor(v) === v && v >= -2147483648 && v <= 2147483647 && !(v === 0 && 1 / v < 0)) {
          return '{"$numberInt":"' + v + '"}';
        }
        return JSON.stringify(v);
      case "boolean":
        return v ? "true" : "false";
      case "string":
        return JSON.stringify(v);
      case "bigint":
        return '{"$numberLong":"' + v + '"}';
      case "undefined":
      case "function":
      case "symbol":
        return undefined;
    }
    if (v instanceof Date) {
      var ms = v.getTime();
      if (ms !== ms) throw new Error("Invalid Date cannot be sent to MongoDB");
      return '{"$date":{"$numberLong":"' + ms + '"}}';
    }
    if (v instanceof RegExp) return JSON.stringify(regexJson(v));
    if (v instanceof Cursor) return wire(v._all());
    if (typeof v.toJSON === "function") return JSON.stringify(v.toJSON());
    if (Array.isArray(v)) {
      return "[" + v.map(function (x) { var s = wire(x); return s === undefined ? "null" : s; }).join(",") + "]";
    }
    if (isEjsonValue(v)) return JSON.stringify(v);
    var parts = [];
    Object.keys(v).forEach(function (k) {
      var s = wire(v[k]);
      if (s !== undefined) parts.push(JSON.stringify(k) + ":" + s);
    });
    return "{" + parts.join(",") + "}";
  }

  // Display JSON (print, printjson, the completion value): plain numbers where they are exact.
  function displayReplacer(k, v) {
    var o = this[k];
    if (o instanceof Date) return { $date: isNaN(o.getTime()) ? null : o.toISOString() };
    if (o instanceof RegExp) return regexJson(o);
    if (typeof o === "bigint") return { $numberLong: String(o) };
    if (o instanceof NumberInt) return Number(o.value);
    if (o instanceof NumberLong && Math.abs(Number(o.value)) <= Number.MAX_SAFE_INTEGER) return Number(o.value);
    return v;
  }
  function ej(v, indent) { return JSON.stringify(v, displayReplacer, indent); }

  // The completion value is shown in the result grid: same cell text as a plain find
  // (hex ObjectIds, ISODate("...") dates).
  function gridReplacer(k, v) {
    var o = this[k];
    if (o instanceof ObjectId) return o.str;
    if (o instanceof Date) return isNaN(o.getTime()) ? null : 'ISODate("' + o.toISOString() + '")';
    return displayReplacer.call(this, k, v);
  }

  // Options, sort specs, projections and index keys are not BSON values for the parser.
  function plain(v) { return JSON.stringify(v, displayReplacer); }

  function revive(k, v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    var ks = Object.keys(v);
    if (ks.length !== 1) return v;
    switch (ks[0]) {
      case "$oid": return new ObjectId(v.$oid);
      case "$date": {
        // Canonical {"$date":{"$numberLong":".."}} arrives with the inner value already revived.
        var d = v.$date;
        if (d instanceof NumberLong) d = Number(d.value);
        return new Date(d);
      }
      case "$numberLong": return new NumberLong(v.$numberLong);
      case "$numberInt": return Number(v.$numberInt);
      case "$numberDouble": return Number(v.$numberDouble);
      case "$numberDecimal": return new NumberDecimal(v.$numberDecimal);
      case "$uuid": return new UUID(v.$uuid);
    }
    return v;
  }

  function run(src) {
    var r = JSON.parse(exec(src, displaying), revive);
    if (r.error !== undefined) throw new Error(r.error);
    if (r.truncated) valueTruncated = true;
    return r;
  }

  function docsOf(r) {
    if (r.docs !== undefined) return r.docs;
    var cols = r.columns, rows = r.rows, res = [];
    for (var i = 0; i < rows.length; i++) {
      var o = {};
      for (var j = 0; j < cols.length; j++) o[cols[j]] = rows[i][j];
      res.push(o);
    }
    return res;
  }

  function scalarOf(r) { return r.rows && r.rows.length ? r.rows[0][0] : null; }

  function integer(n, name) {
    var x = Number(n);
    if (!isFinite(x) || Math.floor(x) !== x || x < 0) {
      throw new Error(name + "() expects a non-negative integer, got " + String(n));
    }
    return x;
  }

  function Cursor(load, count) {
    this._load = load;
    this._countAll = count;
    this._docs = null;
    this._i = 0;
    this._sort = null;
    this._skip = 0;
    this._limit = 0;
  }
  Cursor.prototype._all = function () {
    if (this._docs === null) this._docs = this._load(this);
    return this._docs;
  };
  Cursor.prototype.sort = function (s) { this._sort = s; return this; };
  Cursor.prototype.skip = function (n) { this._skip = integer(n, "skip"); return this; };
  Cursor.prototype.limit = function (n) { this._limit = integer(n, "limit"); return this; };
  ["pretty", "batchSize", "hint", "maxTimeMS", "comment", "collation", "readPref", "noCursorTimeout"].forEach(function (name) {
    Cursor.prototype[name] = function () { return this; };
  });
  Cursor.prototype.explain = unsupported("cursor.explain");
  Cursor.prototype.toArray = function () { return this._all().slice(); };
  Cursor.prototype.forEach = function (fn) { this._all().forEach(fn); };
  Cursor.prototype.map = function (fn) { return this._all().map(fn); };
  Cursor.prototype.hasNext = function () { return this._i < this._all().length; };
  Cursor.prototype.next = function () {
    var d = this._all();
    if (this._i >= d.length) throw new Error("error hasNext: false");
    return d[this._i++];
  };
  // Like the shell, count() counts every matching document regardless of skip/limit.
  Cursor.prototype.count = function () { return this._countAll ? this._countAll() : this._all().length; };
  Cursor.prototype.itcount = function () { return this._all().length; };
  Cursor.prototype.size = Cursor.prototype.itcount;
  Cursor.prototype.toJSON = function () { return this._all(); };

  function Collection(dbName, name) {
    this._dbName = dbName;
    this._name = name;
  }
  Collection.prototype._base = function () {
    var b = this._dbName === null ? "db" : "db.getSiblingDB(" + JSON.stringify(this._dbName) + ")";
    return b + ".getCollection(" + JSON.stringify(this._name) + ")";
  };
  // args: [value, encoder] pairs; values left undefined are dropped from the end.
  Collection.prototype._call = function (method, args) {
    while (args.length && args[args.length - 1][0] === undefined) args.pop();
    return run(this._base() + "." + method + "(" + args.map(function (a) { return a[1](a[0]); }).join(",") + ")");
  };
  Collection.prototype.getName = function () { return this._name; };
  Collection.prototype.find = function (filter, projection) {
    var self = this;
    var f = filter === undefined ? {} : filter;
    return new Cursor(function (c) {
      var src = self._base() + ".find(" + wire(f) + (projection !== undefined ? "," + plain(projection) : "") + ")";
      if (c._sort) src += ".sort(" + plain(c._sort) + ")";
      if (c._skip) src += ".skip(" + c._skip + ")";
      // limit(0) is "no limit" (the parser would otherwise apply its 100-row page); the host
      // still enforces the per-operation row limit.
      src += ".limit(" + c._limit + ")";
      return docsOf(run(src));
    }, function () { return self.countDocuments(f); });
  };
  Collection.prototype.findOne = function (filter, projection) {
    var docs = docsOf(this._call("findOne", [[filter === undefined ? {} : filter, wire], [projection, plain]]));
    return docs.length ? docs[0] : null;
  };
  Collection.prototype.aggregate = function (pipeline, options) {
    var self = this;
    return new Cursor(function () {
      return docsOf(self._call("aggregate", [[pipeline || [], wire], [options, plain]]));
    });
  };
  Collection.prototype.countDocuments = function (filter) {
    return Number(scalarOf(this._call("countDocuments", [[filter === undefined ? {} : filter, wire]])) || 0);
  };
  Collection.prototype.count = Collection.prototype.countDocuments;
  Collection.prototype.estimatedDocumentCount = function () {
    return Number(scalarOf(this._call("estimatedDocumentCount", [])) || 0);
  };
  Collection.prototype.distinct = function (field, filter) {
    return docsOf(this._call("distinct", [[field, plain], [filter, wire]]));
  };
  Collection.prototype.getIndexes = function () { return docsOf(this._call("getIndexes", [])); };
  Collection.prototype.stats = function () { var docs = docsOf(this._call("stats", [])); return docs.length ? docs[0] : null; };

  function withId(doc, method) {
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error(method + "() expects a document");
    // Like the shell, the _id is generated on the client so the caller learns it.
    if (doc._id === undefined) doc._id = new ObjectId();
    return doc;
  }
  Collection.prototype.insertOne = function (doc) {
    withId(doc, "insertOne");
    this._call("insertOne", [[doc, wire]]);
    return { acknowledged: true, insertedId: doc._id };
  };
  Collection.prototype.insertMany = function (docs) {
    if (!Array.isArray(docs)) throw new Error("insertMany() expects an array of documents");
    var ids = {};
    docs.forEach(function (doc, i) { ids[i] = withId(doc, "insertMany")._id; });
    var r = this._call("insertMany", [[docs, wire]]);
    return { acknowledged: true, insertedCount: r.write ? r.write.inserted : docs.length, insertedIds: ids };
  };
  Collection.prototype.insert = function (docs) {
    return Array.isArray(docs) ? this.insertMany(docs) : this.insertOne(docs);
  };
  function updateResult(r) {
    var w = r.write || {};
    var upserted = w.upsertedId === undefined ? null : w.upsertedId;
    return {
      acknowledged: true,
      matchedCount: w.matched,
      modifiedCount: w.modified,
      upsertedCount: upserted === null ? 0 : 1,
      upsertedId: upserted,
    };
  }
  ["updateOne", "updateMany", "replaceOne"].forEach(function (m) {
    Collection.prototype[m] = function (filter, update, options) {
      return updateResult(this._call(m, [[filter, wire], [update, wire], [options, plain]]));
    };
  });
  ["deleteOne", "deleteMany"].forEach(function (m) {
    Collection.prototype[m] = function (filter) {
      var r = this._call(m, [[filter === undefined ? {} : filter, wire]]);
      return { acknowledged: true, deletedCount: r.write ? r.write.deleted : 0 };
    };
  });
  Collection.prototype.bulkWrite = function (operations, options) {
    var w = this._call("bulkWrite", [[operations, wire], [options, plain]]).write || {};
    return {
      acknowledged: true,
      insertedCount: w.inserted,
      matchedCount: w.matched,
      modifiedCount: w.modified,
      deletedCount: w.deleted,
      upsertedCount: w.upserted,
    };
  };
  Collection.prototype.findOneAndUpdate = function (filter, update, options) {
    var docs = docsOf(this._call("findOneAndUpdate", [[filter, wire], [update, wire], [options, plain]]));
    return docs.length ? docs[0] : null;
  };
  Collection.prototype.findOneAndReplace = function (filter, replacement, options) {
    var docs = docsOf(this._call("findOneAndReplace", [[filter, wire], [replacement, wire], [options, plain]]));
    return docs.length ? docs[0] : null;
  };
  Collection.prototype.findOneAndDelete = function (filter, options) {
    var docs = docsOf(this._call("findOneAndDelete", [[filter, wire], [options, plain]]));
    return docs.length ? docs[0] : null;
  };
  Collection.prototype.createIndex = function (keys, options) {
    return scalarOf(this._call("createIndex", [[keys, plain], [options, plain]]));
  };
  Collection.prototype.dropIndex = function (index) {
    this._call("dropIndex", [[index, plain]]);
    return { ok: 1 };
  };
  Collection.prototype.dropIndexes = function (indexes) {
    this._call("dropIndexes", [[indexes, plain]]);
    return { ok: 1 };
  };
  Collection.prototype.renameCollection = function (name) {
    this._call("renameCollection", [[name, plain]]);
    return { ok: 1 };
  };
  Collection.prototype.drop = function () { this._call("drop", []); return true; };

  var dbApi = {
    getName: function () { return this._dbName === null ? "" : this._dbName; },
    getCollection: function (name) { return new Collection(this._dbName, name); },
    getSiblingDB: function (name) { return makeDb(name); },
    version: function () { return scalarOf(run("db.version()")); },
  };
  // Database methods of the shell that scripts cannot run: an explicit error instead of
  // silently treating the name as a collection.
  [
    "runCommand", "adminCommand", "getCollectionNames", "getCollectionInfos", "createCollection", "createView",
    "dropDatabase", "stats", "serverStatus", "currentOp", "killOp", "getUsers", "createUser", "dropUser",
    "aggregate", "watch", "hello", "isMaster", "getMongo", "listCommands", "setProfilingLevel",
    "getProfilingStatus", "printCollectionStats", "fsyncLock", "fsyncUnlock", "auth", "logout",
  ].forEach(function (name) { dbApi[name] = unsupported("db." + name); });

  function makeDb(dbName) {
    var target = { _dbName: dbName };
    return new Proxy(target, {
      get: function (t, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "_dbName") return t._dbName;
        if (Object.prototype.hasOwnProperty.call(dbApi, prop)) return dbApi[prop].bind(t);
        if (prop === "toJSON" || prop === "then") return undefined;
        return new Collection(t._dbName, prop);
      },
    });
  }

  function fmt(v) {
    if (typeof v === "string") return v;
    if (v !== null && typeof v === "object") return ej(v);
    return String(v);
  }
  g.print = function () { emit(Array.prototype.map.call(arguments, fmt).join(" ")); };
  g.printjson = function (v) { emit(String(ej(v, 2))); };
  g.tojson = function (v) { return ej(v, 2); };
  g.db = makeDb(null);
  g.ObjectId = ObjectId;
  g.ISODate = ISODate;
  g.NumberLong = NumberLong;
  g.NumberInt = NumberInt;
  g.NumberDecimal = NumberDecimal;
  g.UUID = UUID;
  g.Timestamp = Timestamp;
  g.BinData = BinData;

  // Taken by the host right after this layer is evaluated, then removed from the global object.
  g.__dbx_finish = function (v) {
    var value;
    displaying = true;
    try {
      value = v === undefined ? null : JSON.stringify(v, gridReplacer);
    } finally {
      displaying = false;
    }
    return JSON.stringify({
      value: value === undefined ? null : value,
      output: out,
      outputTruncated: outTruncated,
      valueTruncated: valueTruncated,
    });
  };
})(globalThis);

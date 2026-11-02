import { describe, expect, it } from "vitest";
import { compositeInputComplete, compositeObjectTypes, compositeNode, compositeChildShape, emptyCompositeValue, type CompositeRoot } from "@/lib/debug/plDebugComposite";
import type { PlDebugTargetSignature } from "@/lib/debug/plDebugProtocol";

describe("composite collection input bounds", () => {
  it.each(["BLOB", "RAW"])("keeps %s binary envelopes distinct from text and NULL", (type) => {
    const signature = {} as PlDebugTargetSignature;
    const shape = { type };
    const kind = type === "BLOB" ? "blob" : "raw";
    expect(emptyCompositeValue(signature, shape)).toEqual({ kind, value: { encoding: "base64", data: "" } });
    for (const data of ["", "AA==", "AAH/", "/w=="]) expect(compositeInputComplete(signature, shape, { kind, value: { encoding: "base64", data } })).toBe(true);
    for (const data of ["AA", "AB==", "AA==\n", "-w==", "==="]) expect(compositeInputComplete(signature, shape, { kind, value: { encoding: "base64", data } })).toBe(false);
    expect(compositeInputComplete(signature, shape, { kind, value: null })).toBe(true);
    expect(compositeInputComplete(signature, shape, { kind: "text", value: "AA==" })).toBe(false);
  });
  it.each(["TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH TZ"])("keeps structured %s leaves and nanoseconds", (type) => {
    const signature = {} as PlDebugTargetSignature;
    const shape = compositeChildShape({ ATTR_TYPE_NAME: type }, "ATTR_TYPE_");
    expect(emptyCompositeValue(signature, shape)).toEqual({ kind: "timestamp_tz", value: { local: "", offset: "+00:00", region: null } });
    expect(compositeInputComplete(signature, shape, { kind: "timestamp_tz", value: { local: "2025-11-02T01:30:00.123456789", offset: "-04:00", region: "America/New_York" } })).toBe(true);
    expect(compositeInputComplete(signature, shape, { kind: "timestamp_tz", value: null })).toBe(true);
    expect(compositeInputComplete(signature, shape, { kind: "text", value: "2025-11-02T01:30:00-04:00" })).toBe(false);
  });
  it.each(["TIMESTAMP WITH LOCAL TIME ZONE", "TIMESTAMP WITH LOCAL TZ"])("keeps structured %s UTC instants", (type) => {
    const signature = {} as PlDebugTargetSignature;
    const shape = compositeChildShape({ ELEM_TYPE_NAME: type }, "ELEM_TYPE_");
    expect(emptyCompositeValue(signature, shape)).toEqual({ kind: "timestamp_ltz", value: { instant: "" } });
    expect(compositeInputComplete(signature, shape, { kind: "timestamp_ltz", value: { instant: "2025-11-02T05:30:00.123456789Z" } })).toBe(true);
    expect(compositeInputComplete(signature, shape, { kind: "timestamp_ltz", value: null })).toBe(true);
    expect(compositeInputComplete(signature, shape, { kind: "timestamp_ltz", value: { instant: "2025-11-02T05:30:00" } })).toBe(false);
  });
  it.each(["BINARY_FLOAT", "BINARY_DOUBLE"])("validates %s as fixed-width hexadecimal rather than a decimal number", (type) => {
    const signature = {} as PlDebugTargetSignature;
    const kind = type === "BINARY_FLOAT" ? "binary_float" : "binary_double";
    const value = type === "BINARY_FLOAT" ? "ff800000" : "fff0000000000000";
    expect(emptyCompositeValue(signature, { type })).toEqual({ kind, value: "" });
    expect(compositeInputComplete(signature, { type }, { kind, value })).toBe(true);
    expect(compositeInputComplete(signature, { type }, { kind, value: null })).toBe(true);
    for (const invalid of ["", "1.25", `0x${value}`, value.slice(1), `${value}0`, value.replace("f", "Ｆ")]) expect(compositeInputComplete(signature, { type }, { kind, value: invalid })).toBe(false);
    expect(compositeInputComplete(signature, { type }, { kind: "number", value: "1" })).toBe(false);
  });
  it.each([
    ["NCLOB", "nclob"],
    ["CLOB", "clob"],
    ["DATE", "date"],
    ["TIMESTAMP", "timestamp"],
    ["INTEGER", "number"],
    ["PLS_INTEGER", "number"],
    ["BINARY_INTEGER", "number"],
    ["SIMPLE_INTEGER", "number"],
    ["PL/SQL PLS INTEGER", "number"],
    ["PL/SQL BINARY INTEGER", "number"],
  ])("keeps %s leaf transport identity", (type, kind) => {
    const signature = {} as PlDebugTargetSignature;
    const value = emptyCompositeValue(signature, { type });
    expect(value).toEqual({ kind, value: "" });
    expect(compositeInputComplete(signature, { type }, { kind: "text", value: "x" })).toBe(false);
    if (value.kind !== "record" && value.kind !== "collection" && value.kind !== "object" && value.kind !== "boolean") {
      value.value = kind === "number" ? "19" : "中\n🙂 ";
      expect(compositeInputComplete(signature, { type }, value)).toBe(true);
      value.value = null;
      expect(compositeInputComplete(signature, { type }, value)).toBe(true);
    }
  });
  it("applies UPPER_BOUND only to varrays, not the nested-table sentinel", () => {
    const reference = { owner: "S", packageName: null, typeName: "NT" };
    const signature = { typeGraph: { nodes: [{ reference, definition: { TYPECODE: "COLLECTION" }, attributes: [], collections: [{ COLL_TYPE: "TABLE", UPPER_BOUND: "-1", ELEM_TYPE_NAME: "NUMBER" }] }], versions: [] } } as unknown as PlDebugTargetSignature;
    const shape = { reference, type: "EXT" };
    const value: CompositeRoot = {
      kind: "collection",
      value: [
        { index: "1", value: { kind: "number", value: "3" } },
        { index: "3", value: { kind: "number", value: "7" } },
      ],
    };
    expect(compositeInputComplete(signature, shape, value)).toBe(true);
    signature.typeGraph!.nodes[0]!.collections[0] = { COLL_TYPE: "VARYING ARRAY", UPPER_BOUND: "2", ELEM_TYPE_NAME: "NUMBER" };
    expect(compositeInputComplete(signature, shape, value)).toBe(false);
    value.value![1]!.index = "2";
    expect(compositeInputComplete(signature, shape, value)).toBe(true);
  });
});

describe("object construction identity", () => {
  it("accepts a frozen subtype and normalizes omitted SQL package namespaces without changing the signature", () => {
    const reference = { owner: "S", packageName: null, typeName: "BASE" };
    const sub = { owner: "S", packageName: null, typeName: "SUB" };
    const signature = JSON.parse(
      JSON.stringify(
        {
          typeGraph: {
            versions: [],
            nodes: [
              {
                reference,
                definition: { TYPECODE: "OBJECT", FINAL: "NO" },
                attributes: [],
                collections: [],
                objectAccess: { state: "type_only_verified" },
                constructorCalls: { state: "resolved", constructors: [{ id: "user-1", origin: "user", parameters: [{ name: "N", type: { ATTR_TYPE_NAME: "NUMBER" }, defaulted: false }] }] },
              },
              {
                reference: sub,
                definition: { TYPECODE: "OBJECT", FINAL: "YES", SUPERTYPE_OWNER: "S", SUPERTYPE_NAME: "BASE" },
                attributes: [],
                collections: [],
                objectAccess: { state: "type_only_verified" },
                constructorCalls: { state: "resolved", constructors: [{ id: "user-1", origin: "user", parameters: [{ name: "N", type: { ATTR_TYPE_NAME: "NUMBER" }, defaulted: false }] }] },
              },
            ],
          },
        },
        (key, value) => (key === "packageName" && value === null ? undefined : value),
      ),
    ) as PlDebugTargetSignature;
    const value: CompositeRoot = { kind: "object", value: { type: sub, constructorId: "user-1", arguments: [{ name: "N", state: "value", value: { kind: "number", value: "19" } }] } };
    expect(compositeObjectTypes(signature, { reference, type: "EXT" })).toHaveLength(2);
    expect(compositeInputComplete(signature, { reference, type: "EXT" }, value)).toBe(true);
    expect(compositeNode(signature, compositeChildShape({ ATTR_TYPE_OWNER: "S", ATTR_TYPE_NAME: "SUB" }, "ATTR_TYPE_"))?.reference.typeName).toBe("SUB");
    expect(Object.hasOwn(signature.typeGraph!.nodes[0]!.reference, "packageName")).toBe(false);
    expect(compositeInputComplete(signature, { reference: sub, type: "EXT" }, { kind: "object", value: { ...value.value!, type: reference } })).toBe(false);
  });

  it("keeps atomic NULL available when constructors are unresolved, but not after a confirmed type access failure", () => {
    const reference = { owner: "S", packageName: null, typeName: "T" };
    const signature = { typeGraph: { versions: [], nodes: [{ reference, definition: { TYPECODE: "OBJECT" }, attributes: [], collections: [], constructorCalls: { state: "constructor_metadata_unresolved", constructors: [] } }] } } as unknown as PlDebugTargetSignature;
    expect(compositeInputComplete(signature, { reference, type: "EXT" }, { kind: "object", value: null })).toBe(true);
    expect(compositeInputComplete(signature, { reference, type: "EXT" }, { kind: "object", value: { type: reference, constructorId: "user-1", arguments: [] } })).toBe(false);
    signature.typeGraph!.nodes[0]!.objectAccess = { state: "type_only_check_failed", sqlState: "42000", vendorCode: 1031 };
    expect(compositeInputComplete(signature, { reference, type: "EXT" }, { kind: "object", value: null })).toBe(false);
  });
});

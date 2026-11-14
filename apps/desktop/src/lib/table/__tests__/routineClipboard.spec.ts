import { describe, expect, it } from "vitest";
import type { DatabaseType, TreeNode } from "@/types/database";
import { routineClipboardEntryForSelection, routineClipboardPasteTarget, supportsRoutineClipboardDatabase, type RoutineClipboardEntry } from "../routineClipboard";

const node = (extra: Partial<TreeNode> = {}): TreeNode => ({ id: "proc", type: "procedure", label: "calculate_total(integer)", objectName: "calculate_total", signature: "integer", connectionId: "conn", database: "app", schema: "public", ...extra });
const entry: RoutineClipboardEntry = { connectionId: "conn", database: "app", schema: "public", name: "calculate_total", objectType: "PROCEDURE", signature: "integer" };
const postgres = () => "postgres" as const;

describe("routine clipboard selection", () => {
  it.each(["mysql", "postgres", "sqlserver", "oracle", "oceanbase-oracle"] as const)("supports %s without guessing compatible engines", (databaseType) => {
    expect(supportsRoutineClipboardDatabase(databaseType)).toBe(true);
    expect(routineClipboardEntryForSelection([node()], () => databaseType)).toEqual(entry);
  });

  it.each([undefined, "sqlite", "dameng", "kingbase", "jdbc"] as (DatabaseType | undefined)[])("leaves unsupported engine %s as ordinary name copying", (databaseType) => {
    expect(supportsRoutineClipboardDatabase(databaseType)).toBe(false);
    expect(routineClipboardEntryForSelection([node()], () => databaseType)).toBeNull();
  });

  it("uses objectName and preserves both overloaded and explicit empty signatures", () => {
    expect(routineClipboardEntryForSelection([node({ label: "unrelated display" })], postgres)).toEqual(entry);
    expect(routineClipboardEntryForSelection([node({ signature: "" })], postgres)?.signature).toBe("");
    expect(routineClipboardEntryForSelection([node({ signature: undefined })], postgres)).not.toHaveProperty("signature");
  });

  it("strips only the known display signature when legacy nodes lack objectName", () => {
    expect(routineClipboardEntryForSelection([node({ objectName: undefined })], postgres)?.name).toBe("calculate_total");
    expect(routineClipboardEntryForSelection([node({ objectName: undefined, label: "routine(with spaces)(integer)" })], postgres)?.name).toBe("routine(with spaces)");
  });

  it.each(["package", "package-body", "type", "type-body"] as const)("does not treat %s members as standalone routines", (parentType) => {
    expect(routineClipboardEntryForSelection([node({ parentType, parentName: "parent_object" })], postgres)).toBeNull();
  });

  it("requires exactly one complete routine and refuses mixed or multiple selections", () => {
    expect(routineClipboardEntryForSelection([], postgres)).toBeNull();
    expect(routineClipboardEntryForSelection([node(), node({ id: "other" })], postgres)).toBeNull();
    expect(routineClipboardEntryForSelection([node(), node({ type: "table" })], postgres)).toBeNull();
    for (const extra of [{ connectionId: undefined }, { database: undefined }, { type: "table" as const }, { linkedServer: "remote" }, { objectName: "", label: " " }]) {
      expect(routineClipboardEntryForSelection([node(extra)], postgres)).toBeNull();
    }
  });

  it("captures the caller-normalized schema without changing identifier whitespace", () => {
    expect(routineClipboardEntryForSelection([node({ schema: undefined })], postgres, () => "public")).toEqual(entry);
    expect(routineClipboardEntryForSelection([node({ objectName: " spaced name " })], postgres)?.name).toBe(" spaced name ");
  });
});

describe("routine clipboard paste target", () => {
  it.each(["procedure", "group-procedures", "database", "schema"] as const)("accepts a same-scope %s target", (type) => {
    expect(routineClipboardPasteTarget(entry, node({ type }))).toEqual({ connectionId: "conn", database: "app", schema: "public" });
  });

  it("keeps procedure and function destinations separate", () => {
    expect(routineClipboardPasteTarget(entry, node({ type: "function" }))).toBeNull();
    expect(routineClipboardPasteTarget(entry, node({ type: "group-functions" }))).toBeNull();
    const functionEntry = { ...entry, objectType: "FUNCTION" as const };
    expect(routineClipboardPasteTarget(functionEntry, node({ type: "function" }))).not.toBeNull();
    expect(routineClipboardPasteTarget(functionEntry, node({ type: "group-functions" }))).not.toBeNull();
  });

  it("rejects cross-connection/database/schema and unrelated or nested object targets", () => {
    for (const extra of [{ connectionId: "other" }, { database: "other" }, { schema: "other" }, { type: "table" as const }, { type: "connection" as const }, { parentType: "package" as const, parentName: "p" }, { linkedServer: "remote" }]) {
      expect(routineClipboardPasteTarget(entry, node(extra))).toBeNull();
    }
  });

  it("uses schema-node label fallback and caller normalization for schema-less engines", () => {
    expect(routineClipboardPasteTarget(entry, node({ type: "schema", label: "public", schema: undefined }))).not.toBeNull();
    expect(routineClipboardPasteTarget(entry, node({ type: "database", schema: undefined }), () => undefined)).toEqual({ connectionId: "conn", database: "app", schema: "public" });
    const mysqlEntry = { ...entry, schema: undefined };
    expect(routineClipboardPasteTarget(mysqlEntry, node({ type: "database", schema: undefined }), () => undefined)).toEqual({ connectionId: "conn", database: "app", schema: undefined });
    expect(routineClipboardPasteTarget({ ...entry, schema: "" }, node({ schema: undefined }))).not.toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSchemaSelection } from "@/lib/database/schemaSelection";
const backend = vi.hoisted(() => ({ listSchemas: vi.fn(), executeQuery: vi.fn() }));
vi.mock("@/lib/backend/api", () => backend);
beforeEach(() => {
  backend.listSchemas.mockReset().mockResolvedValue(["APP", "SALES", "SYS", "SYSRAC"]);
  backend.executeQuery.mockReset().mockResolvedValue({ columns: ["USERNAME"], rows: [["SYS"], ["SYSRAC"]] });
});
describe("read-only schema selection previews", () => {
  it("loads complete candidates and previews corrected defaults", async () => {
    const result = await loadSchemaSelection("c", "XE", { db_type: "oracle", show_system_schemas: false });
    expect(backend.listSchemas).toHaveBeenCalledWith("c", "XE", false, true);
    expect(result.names).toEqual(["APP", "SALES", "SYS", "SYSRAC"]);
    expect(result.selected).toEqual(["APP", "SALES"]);
    expect([...result.systemNames]).toEqual(["SYS", "SYSRAC"]);
  });
  it("uses Oracle maintenance metadata for grouping and default selection", async () => {
    backend.listSchemas.mockResolvedValue(["APP", "INSTALLER"]);
    backend.executeQuery.mockResolvedValue({ columns: ["USERNAME"], rows: [["INSTALLER"]] });
    const result = await loadSchemaSelection("c", "XE", { db_type: "oracle" });
    expect(result.selected).toEqual(["APP"]);
    expect([...result.systemNames]).toEqual(["INSTALLER"]);
  });
  it("preserves an explicit scope, including unavailable names, ahead of legacy patterns and toggles", async () => {
    const result = await loadSchemaSelection("c", "XE", { db_type: "oracle", database: "XE", visible_schemas: { XE: ["SYS", "MISSING", "SYS"] }, visible_databases: ["APP"], visible_database_patterns: ["%"], show_system_schemas: true });
    expect(result.selected).toEqual(["SYS", "MISSING"]);
  });
  it("keeps explicit empty selection empty", async () => {
    expect((await loadSchemaSelection("c", "XE", { db_type: "oracle", database: "XE", visible_schemas: { XE: [] }, show_system_schemas: true })).selected).toEqual([]);
  });
  it("previews the main root list and wildcard union without applying system hiding again", async () => {
    const result = await loadSchemaSelection("c", "", { db_type: "oceanbase-oracle", visible_databases: ["SYS"], visible_database_patterns: ["SA%"], show_system_schemas: false });
    expect(result.selected).toEqual(["SALES", "SYS"]);
  });
  it("previews the main show-system setting without changing connection configuration", async () => {
    const config = { db_type: "oracle" as const, show_system_schemas: true };
    const before = structuredClone(config);
    const result = await loadSchemaSelection("c", "XE", config);
    expect(result.selected).toEqual(result.names);
    expect(config).toEqual(before);
  });
  it("previews new defaults and manual overrides, keeping unavailable choices without writing", async () => {
    const config = { db_type: "oracle" as const, database: "XE", schema_visibility: { migrate_legacy: false, databases: { XE: { SALES: false, SYS: true, MISSING: true } } } };
    const before = structuredClone(config);
    const result = await loadSchemaSelection("c", "XE", config);
    expect(result.selected).toEqual(["APP", "SYS", "MISSING"]);
    expect(result.systemNames).toEqual(new Set(["SYS", "SYSRAC"]));
    expect(config).toEqual(before);
  });
  it("retains the known-name fallback on older Oracle and propagates enumeration failures", async () => {
    backend.executeQuery.mockRejectedValue(new Error("ORA-00904"));
    expect((await loadSchemaSelection("c", "XE", { db_type: "oracle" })).selected).toEqual(["APP", "SALES"]);
    backend.listSchemas.mockRejectedValue(new Error("offline"));
    await expect(loadSchemaSelection("c", "XE", { db_type: "oracle" })).rejects.toThrow("offline");
  });
});

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { loadVirtualRowIdentifier, removeVirtualRowIdentifier, saveVirtualRowIdentifier, virtualRowIdentifierScopeKey } from "@/lib/table/virtualRowIdentifier";
import type { ColumnInfo } from "@/types/database";

const scope = {
  connectionId: "db2-1",
  database: "MAXIMO",
  schema: "APP",
  tableName: "MAFAPPDATA",
};

function column(name: string): ColumnInfo {
  return { name, data_type: "VARCHAR", is_nullable: true, column_default: null, is_primary_key: false, extra: null };
}

describe("virtualRowIdentifier", () => {
  beforeEach(() => localStorage.clear());

  it("persists a composite key for one exact table scope", () => {
    const columns = [column("TENANT_ID"), column("APP_ID"), column("APP")];

    expect(saveVirtualRowIdentifier(scope, ["TENANT_ID", "APP_ID"], columns)).toBe(true);
    expect(loadVirtualRowIdentifier(scope, columns)).toEqual(["TENANT_ID", "APP_ID"]);
    expect(loadVirtualRowIdentifier({ ...scope, tableName: "OTHER_TABLE" }, columns)).toEqual([]);
    expect(virtualRowIdentifierScopeKey(scope)).not.toBe(virtualRowIdentifierScopeKey({ ...scope, catalog: "ARCHIVE" }));
  });

  it("canonicalizes unambiguous casing and removes a key when a column disappears", () => {
    expect(saveVirtualRowIdentifier(scope, ["app_id"], [column("app_id")])).toBe(true);
    expect(loadVirtualRowIdentifier(scope, [column("APP_ID")])).toEqual(["APP_ID"]);
    expect(loadVirtualRowIdentifier(scope, [column("OTHER_ID")])).toEqual([]);
    expect(loadVirtualRowIdentifier(scope, [column("APP_ID")])).toEqual([]);
  });

  it("rejects empty, duplicate, and unknown column selections", () => {
    const columns = [column("ID"), column("NAME")];

    expect(saveVirtualRowIdentifier(scope, [], columns)).toBe(false);
    expect(saveVirtualRowIdentifier(scope, ["ID", "ID"], columns)).toBe(false);
    expect(saveVirtualRowIdentifier(scope, ["MISSING"], columns)).toBe(false);
    expect(loadVirtualRowIdentifier(scope, columns)).toEqual([]);
  });

  it("clears a persisted key", () => {
    const columns = [column("ID")];
    expect(saveVirtualRowIdentifier(scope, ["ID"], columns)).toBe(true);

    removeVirtualRowIdentifier(scope);

    expect(loadVirtualRowIdentifier(scope, columns)).toEqual([]);
  });
});

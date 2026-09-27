import { describe, expect, it } from "vitest";
import {
  DBX_NEO4J_ELEMENT_ID_COLUMN,
  DBX_ROWID_COLUMN,
  DBX_TDENGINE_TBNAME_COLUMN,
  canInsertTableRows,
  canDeleteExistingTdengineRows,
  canEditExistingTableRows,
  canUseKeylessRowPredicate,
  editablePrimaryKeys,
  editableRowIdentifierColumns,
  hasCompleteTdengineRowIdentity,
  isClickHouseExistingRowReadonlyColumn,
  isHiddenGridColumn,
  isSalesforceExistingRowReadonlyColumn,
  isSalesforceNewRowReadonlyColumn,
  isTdengineExistingRowReadonlyColumn,
  isTableDataEditable,
  parseSalesforceColumnExtra,
  supportsDataGridTransaction,
  shouldIncludeSyntheticRowId,
  usesSyntheticRowIdKey,
} from "@/lib/table/tableEditing";
import type { ColumnInfo, IndexInfo } from "@/types/database";

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return {
    name,
    data_type: "varchar",
    is_nullable: true,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra: null,
  };
}

function index(columns: string[], isUnique = true, filter: string | null = null): IndexInfo {
  return {
    name: columns.join("_"),
    columns,
    is_unique: isUnique,
    is_primary: false,
    filter,
  };
}

describe("tableEditing", () => {
  it("synthesizes ROWID only for Oracle-compatible base tables", () => {
    expect(editablePrimaryKeys("oracle", [column("ID"), column("NAME")])).toEqual([]);
    expect(editablePrimaryKeys("oracle", [column("ID"), column("NAME")], "VIEW")).toEqual([]);
    expect(editablePrimaryKeys("oracle", [column("ID"), column("NAME")], "TABLE")).toEqual([DBX_ROWID_COLUMN]);
    expect(editablePrimaryKeys("oceanbase-oracle", [column("ID"), column("NAME")], "TABLE")).toEqual([DBX_ROWID_COLUMN]);
    expect(editablePrimaryKeys("oceanbase-oracle", [column("ID", true), column("NAME")], "TABLE")).toEqual(["ID"]);
  });

  it("uses Xugu ROWID for ordinary, partitioned, and temporary tables but not views", () => {
    const columns = [column("ID"), column("VALUE")];
    expect(editablePrimaryKeys("xugu", columns, "TABLE")).toEqual([DBX_ROWID_COLUMN]);
    expect(editablePrimaryKeys("xugu", columns, "PARTITIONED TABLE")).toEqual([DBX_ROWID_COLUMN]);
    expect(editablePrimaryKeys("xugu", columns, "TEMPORARY TABLE")).toEqual([DBX_ROWID_COLUMN]);
    expect(editablePrimaryKeys("xugu", columns, "VIEW")).toEqual([]);
    expect(usesSyntheticRowIdKey("xugu", [DBX_ROWID_COLUMN], "TABLE")).toBe(true);
    expect(usesSyntheticRowIdKey("xugu", [DBX_ROWID_COLUMN], "PARTITIONED TABLE")).toBe(true);
    expect(usesSyntheticRowIdKey("xugu", [DBX_ROWID_COLUMN], "TEMPORARY TABLE")).toBe(true);
    expect(usesSyntheticRowIdKey("xugu", [DBX_ROWID_COLUMN], "VIEW")).toBe(false);
    expect(isTableDataEditable("xugu", [DBX_ROWID_COLUMN], "TABLE")).toBe(true);
    expect(isTableDataEditable("xugu", [DBX_ROWID_COLUMN], "VIEW")).toBe(false);
    expect(canInsertTableRows("xugu")).toBe(true);
  });

  it("includes Xugu ROWID while cold table metadata has no declared primary keys", () => {
    expect(shouldIncludeSyntheticRowId("xugu", [], "TABLE")).toBe(true);
    expect(shouldIncludeSyntheticRowId("xugu", [], "PARTITIONED TABLE")).toBe(true);
    expect(shouldIncludeSyntheticRowId("xugu", [], "TEMPORARY TABLE")).toBe(true);
    expect(shouldIncludeSyntheticRowId("xugu", [], "VIEW")).toBe(false);
    expect(shouldIncludeSyntheticRowId("oracle", [], "TABLE")).toBe(false);
  });

  it("keeps Xugu's internal ROWID hidden after primary-key metadata arrives", () => {
    expect(isHiddenGridColumn("xugu", DBX_ROWID_COLUMN, ["ID"], "TABLE")).toBe(true);
    expect(isHiddenGridColumn("xugu", DBX_ROWID_COLUMN, [], "TABLE")).toBe(true);
    expect(isHiddenGridColumn("xugu", DBX_ROWID_COLUMN, ["ID"], "VIEW")).toBe(false);
    expect(isHiddenGridColumn("xugu", "ID", ["ID"], "TABLE")).toBe(false);
  });

  it("treats view data tabs as readonly", () => {
    expect(isTableDataEditable("oracle", [DBX_ROWID_COLUMN], "VIEW")).toBe(false);
  });

  it("keeps Impala table data readonly", () => {
    expect(isTableDataEditable("impala", ["id"], "TABLE")).toBe(false);
    expect(canEditExistingTableRows("impala", undefined, ["id"])).toBe(false);
    expect(supportsDataGridTransaction("impala")).toBe(false);
  });

  it("does not include Oracle ROWID for view data tabs", () => {
    expect(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN])).toBe(true);
    expect(shouldIncludeSyntheticRowId("oracle", [DBX_ROWID_COLUMN])).toBe(false);
    expect(shouldIncludeSyntheticRowId("oracle", [DBX_ROWID_COLUMN], "TABLE")).toBe(true);
    expect(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN], "VIEW")).toBe(false);
    expect(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN], "MATERIALIZED_VIEW")).toBe(false);
    expect(usesSyntheticRowIdKey("oceanbase-oracle", [DBX_ROWID_COLUMN], "TABLE")).toBe(true);
    expect(usesSyntheticRowIdKey("oceanbase-oracle", [DBX_ROWID_COLUMN], "VIEW")).toBe(false);
  });

  it("allows keyless row predicates only for databases that support them", () => {
    expect(canUseKeylessRowPredicate("postgres", [])).toBe(true);
    expect(canUseKeylessRowPredicate("mysql", [])).toBe(true);
    expect(canUseKeylessRowPredicate("jdbc", [])).toBe(false);
    expect(canUseKeylessRowPredicate("postgres", ["id"])).toBe(false);
  });

  it("uses unique indexes as row identifiers when primary keys are absent", () => {
    expect(editableRowIdentifierColumns("postgres", [column("email"), column("name")], [index(["email", "name"]), index(["email"])])).toEqual(["email"]);
    expect(editableRowIdentifierColumns("postgres", [column("email"), column("name")], [index(["email"], true, "email IS NOT NULL")])).toEqual([]);
    expect(editableRowIdentifierColumns("postgres", [column("id", true), column("email")], [index(["email"])])).toEqual(["id"]);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("prefers physical %s indexes over the ROWID fallback", (databaseType) => {
    const columns = [column("OFFER_RELA_ID"), column("ORI_OFFER_ID")];
    const primaryIndex = { ...index(["OFFER_RELA_ID"], false), is_primary: true };

    expect(editableRowIdentifierColumns(databaseType, columns, [index(["ORI_OFFER_ID"]), primaryIndex], "TABLE")).toEqual(["OFFER_RELA_ID"]);
    expect(editableRowIdentifierColumns(databaseType, columns, [index(["ORI_OFFER_ID"])], "TABLE")).toEqual(["ORI_OFFER_ID"]);
    expect(editableRowIdentifierColumns(databaseType, columns, [index(["ORI_OFFER_ID"], false)], "TABLE")).toEqual([DBX_ROWID_COLUMN]);
    expect(editableRowIdentifierColumns(databaseType, columns, [index(["ORI_OFFER_ID"], true, "ORI_OFFER_ID IS NOT NULL")], "TABLE")).toEqual([DBX_ROWID_COLUMN]);
    expect(editableRowIdentifierColumns(databaseType, columns, [], "TABLE")).toEqual([DBX_ROWID_COLUMN]);
  });

  it("keeps synthetic row identifiers scoped to their existing fallbacks", () => {
    const columns = [column("ID"), column("NAME")];

    expect(editableRowIdentifierColumns("oracle", columns, [], "VIEW")).toEqual([]);
    expect(editableRowIdentifierColumns("oracle", columns, [], "MATERIALIZED_VIEW")).toEqual([]);
    expect(editableRowIdentifierColumns("neo4j", columns, [index(["ID"])], "TABLE")).toEqual([DBX_NEO4J_ELEMENT_ID_COLUMN]);
  });

  it("allows ClickHouse table editing when row identifiers are available", () => {
    expect(isTableDataEditable("clickhouse", ["id"], "BASE TABLE")).toBe(true);
    expect(canEditExistingTableRows("clickhouse", undefined, ["id"])).toBe(true);
    expect(supportsDataGridTransaction("clickhouse")).toBe(false);
    expect(isTableDataEditable("clickhouse", [], "BASE TABLE")).toBe(true);
    expect(canEditExistingTableRows("clickhouse", undefined, [])).toBe(false);
  });

  it("uses tbname only when editing TDengine stable rows", () => {
    const columns = [column("ts", true), column("seq", true), column("voltage")];
    expect(editablePrimaryKeys("tdengine", columns, "STABLE")).toEqual([DBX_TDENGINE_TBNAME_COLUMN, "ts", "seq"]);
    expect(editablePrimaryKeys("tdengine", columns, "TABLE")).toEqual(["ts", "seq"]);
    expect(canEditExistingTableRows("tdengine", undefined, ["ts", "seq"])).toBe(true);
    expect(canEditExistingTableRows("tdengine", undefined, [])).toBe(false);
    expect(isTdengineExistingRowReadonlyColumn("tdengine", "seq", columns)).toBe(true);
  });

  it("requires every TDengine row identifier in editable results", () => {
    const stableKeys = [DBX_TDENGINE_TBNAME_COLUMN, "ts", "seq"];
    expect(hasCompleteTdengineRowIdentity("tdengine", stableKeys, ["tbname", "ts", "seq", "voltage"])).toBe(true);
    expect(hasCompleteTdengineRowIdentity("tdengine", stableKeys, ["tbname", "ts", "voltage"])).toBe(false);
    expect(hasCompleteTdengineRowIdentity("tdengine", ["ts", "seq"], ["ts", "seq", "voltage"])).toBe(true);
    expect(hasCompleteTdengineRowIdentity("postgres", ["id"], [])).toBe(true);
  });

  it("disables existing-row deletion for TDengine composite keys", () => {
    expect(canDeleteExistingTdengineRows("tdengine", ["ts"])).toBe(true);
    expect(canDeleteExistingTdengineRows("tdengine", [DBX_TDENGINE_TBNAME_COLUMN, "ts"])).toBe(true);
    expect(canDeleteExistingTdengineRows("tdengine", ["ts", "seq"])).toBe(false);
    expect(canDeleteExistingTdengineRows("tdengine", [DBX_TDENGINE_TBNAME_COLUMN, "ts", "seq"])).toBe(false);
    expect(canDeleteExistingTdengineRows("postgres", ["id", "tenant_id"])).toBe(true);
  });

  it("treats ClickHouse row identifier cells as readonly on existing rows", () => {
    expect(isClickHouseExistingRowReadonlyColumn("clickhouse", "ID", ["id"])).toBe(true);
    expect(isClickHouseExistingRowReadonlyColumn("clickhouse", "name", ["id"])).toBe(false);
    expect(isClickHouseExistingRowReadonlyColumn("clickhouse", "event_date", ["id"], [{ ...column("event_date"), extra: "partition_key" }])).toBe(true);
    expect(isClickHouseExistingRowReadonlyColumn("postgres", "id", ["id"])).toBe(false);
  });

  describe("salesforce", () => {
    const describeColumns = [
      { ...column("Id", true), extra: JSON.stringify({ updateable: false, createable: false, custom: false, label: "Record ID" }) },
      { ...column("Name"), extra: JSON.stringify({ updateable: true, createable: true, custom: false, label: "Account Name" }) },
      { ...column("CreatedDate"), extra: JSON.stringify({ updateable: false, createable: false, custom: false, label: "Created Date" }) },
      { ...column("Revenue_Rollup__c"), extra: JSON.stringify({ updateable: false, createable: false, custom: true, label: "Revenue Rollup" }) },
      { ...column("First_Name__c"), extra: JSON.stringify({ updateable: true, createable: true, custom: true, label: "First Name" }) },
      { ...column("OwnerId"), extra: JSON.stringify({ updateable: true, createable: true, custom: false, label: "Owner ID", referenceTo: ["User"], relationshipName: "Owner" }) },
    ];

    it("reads describe flags defensively", () => {
      expect(parseSalesforceColumnExtra('{"updateable":false,"label":"Created Date"}')).toEqual({ updateable: false, label: "Created Date" });
      // ClickHouse packs a bare marker string; a non-object must never be read as flags.
      expect(parseSalesforceColumnExtra("partition_key")).toBeNull();
      expect(parseSalesforceColumnExtra("[1,2]")).toBeNull();
      expect(parseSalesforceColumnExtra("")).toBeNull();
      expect(parseSalesforceColumnExtra(null)).toBeNull();
    });

    it("keeps the record Id and non-updateable fields readonly on existing rows", () => {
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "Id", ["Id"], describeColumns)).toBe(true);
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "id", ["Id"], describeColumns)).toBe(true);
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "CreatedDate", ["Id"], describeColumns)).toBe(true);
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "Revenue_Rollup__c", ["Id"], describeColumns)).toBe(true);
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "Name", ["Id"], describeColumns)).toBe(false);
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "first_name__c", ["Id"], describeColumns)).toBe(false);
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "OwnerId", ["Id"], describeColumns)).toBe(false);
      expect(isSalesforceExistingRowReadonlyColumn("postgres", "Id", ["Id"], describeColumns)).toBe(false);
    });

    it("fails open when describe metadata is missing so Salesforce decides", () => {
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "Unknown__c", ["Id"], describeColumns)).toBe(false);
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "Name", ["Id"])).toBe(false);
      expect(isSalesforceNewRowReadonlyColumn("salesforce", "Unknown__c", describeColumns)).toBe(false);
    });

    it("blocks non-createable fields on new rows only", () => {
      expect(isSalesforceNewRowReadonlyColumn("salesforce", "Id", describeColumns)).toBe(true);
      expect(isSalesforceNewRowReadonlyColumn("salesforce", "CreatedDate", describeColumns)).toBe(true);
      expect(isSalesforceNewRowReadonlyColumn("salesforce", "Revenue_Rollup__c", describeColumns)).toBe(true);
      expect(isSalesforceNewRowReadonlyColumn("salesforce", "Name", describeColumns)).toBe(false);
      expect(isSalesforceNewRowReadonlyColumn("salesforce", "First_Name__c", describeColumns)).toBe(false);
      expect(isSalesforceNewRowReadonlyColumn("mysql", "Id", describeColumns)).toBe(false);
      // `Id` is not updateable either, but the primary-key rule covers existing rows.
      expect(isSalesforceExistingRowReadonlyColumn("salesforce", "Id", [], describeColumns)).toBe(true);
    });

    it("edits table data row by row without a transaction", () => {
      expect(isTableDataEditable("salesforce", ["Id"], "TABLE")).toBe(true);
      expect(canEditExistingTableRows("salesforce", undefined, ["Id"])).toBe(true);
      expect(canEditExistingTableRows("salesforce", undefined, [])).toBe(false);
      expect(canInsertTableRows("salesforce")).toBe(true);
      expect(supportsDataGridTransaction("salesforce")).toBe(false);
      expect(canUseKeylessRowPredicate("salesforce", [])).toBe(false);
      expect(canDeleteExistingTdengineRows("salesforce", ["Id"])).toBe(true);
    });
  });
});

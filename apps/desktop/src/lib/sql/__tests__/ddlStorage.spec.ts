import { describe, expect, it } from "vitest";
import { applyDdlStoragePreference } from "../ddlStorage";

const raw = `CREATE TABLE "APP"."SALES" (
  "ID" NUMBER NOT NULL,
  "REGION" VARCHAR2(30) DEFAULT 'PCTFREE = 20',
  CONSTRAINT "CK" CHECK ("ID" > 0)
) COMPRESS FOR ARCHIVE REPLICA_NUM = 1 BLOCK_SIZE = 16384 USE_BLOOM_FILTER = FALSE TABLET_SIZE = 134217728 PCTFREE = 0
partition by range("ID") subpartition by list("REGION")
(partition "P1" values less than (100) (subpartition "S1" values ('PCTFREE = 20')));
CREATE INDEX "I" ON "APP"."SALES"("REGION") LOCAL;
COMMENT ON TABLE "APP"."SALES" IS 'COMPRESS FOR ARCHIVE';`;

describe("OceanBase Oracle DDL storage preference", () => {
  it("omits table storage by default and preserves the semantic DDL and comments", () => {
    const logical = applyDdlStoragePreference(raw, "oceanbase-oracle");
    expect(logical).not.toContain("REPLICA_NUM");
    expect(logical).not.toContain("BLOCK_SIZE");
    expect(logical).not.toContain("TABLET_SIZE");
    expect(logical).not.toContain("PCTFREE = 0");
    expect(logical).toContain("DEFAULT 'PCTFREE = 20'");
    expect(logical.slice(logical.indexOf("partition by"))).toBe(raw.slice(raw.indexOf("partition by")));
    expect(logical).toContain('CONSTRAINT "CK" CHECK ("ID" > 0)');
  });
  it("returns the complete original when disabled and leaves other databases unchanged", () => {
    expect(applyDdlStoragePreference(raw, "oceanbase-oracle", false)).toBe(raw);
    expect(applyDdlStoragePreference(raw, "oracle")).toBe(raw);
    expect(applyDdlStoragePreference(raw, undefined)).toBe(raw);
  });
  it("preserves quoted identifiers, Oracle alternative strings, temporary-table semantics and comments", () => {
    const ddl = `CREATE GLOBAL TEMPORARY TABLE "PCTFREE" ("A" VARCHAR2(100) DEFAULT q'[can't ) PCTFREE=42]') /* PCTFREE=9 */ PCTFREE=0 ON COMMIT PRESERVE ROWS;`;
    expect(applyDdlStoragePreference(ddl, "oceanbase-oracle")).toBe(ddl.replace(" PCTFREE=0", " "));
  });
  it("filters each table without altering unknown attributes, non-table statements or incomplete SQL", () => {
    const ddl = `CREATE TABLE T(A NUMBER) PCTFREE 0 TABLE_MODE='QUEUING'; CREATE TABLE U(A NUMBER) NOCOMPRESS PCTFREE=10; ALTER TABLE T PCTFREE 20;`;
    expect(applyDdlStoragePreference(ddl, "oceanbase-oracle")).toBe(`CREATE TABLE T(A NUMBER)  TABLE_MODE='QUEUING'; CREATE TABLE U(A NUMBER)  ; ALTER TABLE T PCTFREE 20;`);
    const broken = `CREATE TABLE T(A VARCHAR2(100) DEFAULT 'unclosed) PCTFREE=10`;
    expect(applyDdlStoragePreference(broken, "oceanbase-oracle")).toBe(broken);
  });
});

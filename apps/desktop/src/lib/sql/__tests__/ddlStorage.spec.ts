import { describe, expect, it } from "vitest";
import { applyDdlStoragePreference, supportsDdlStoragePreference } from "../ddlStorage";

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
    expect(applyDdlStoragePreference(raw, "mysql")).toBe(raw);
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

// Verbatim `DBMS_METADATA.GET_DDL` output captured from Oracle Database 11g XE, with the
// leading tabs of the column list written as two spaces.
const oracleHeapTableDdl = `CREATE TABLE "DBX_TEST"."DBX_DDL_PROBE" 
   (  "ID" NUMBER(10,0) NOT NULL ENABLE, 
  "NAME" VARCHAR2(50), 
  "CREATED_AT" DATE, 
   CONSTRAINT "DBX_DDL_PROBE_PK" PRIMARY KEY ("ID")
  USING INDEX PCTFREE 10 INITRANS 2 MAXTRANS 255 
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS"  ENABLE
   ) SEGMENT CREATION IMMEDIATE 
  PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255 NOCOMPRESS LOGGING
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS";

CREATE INDEX "DBX_TEST"."DBX_DDL_PROBE_NAME_IDX" ON "DBX_TEST"."DBX_DDL_PROBE" ("NAME") 
  PCTFREE 10 INITRANS 2 MAXTRANS 255 COMPUTE STATISTICS 
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS";`;

const oracleHeapTableDdlWithoutStorage = `CREATE TABLE "DBX_TEST"."DBX_DDL_PROBE" 
   (  "ID" NUMBER(10,0) NOT NULL ENABLE, 
  "NAME" VARCHAR2(50), 
  "CREATED_AT" DATE, 
   CONSTRAINT "DBX_DDL_PROBE_PK" PRIMARY KEY ("ID")
  USING INDEX ENABLE
   ) NOCOMPRESS;

CREATE INDEX "DBX_TEST"."DBX_DDL_PROBE_NAME_IDX" ON "DBX_TEST"."DBX_DDL_PROBE" ("NAME");`;

const oracleIndexOrganizedTableDdl = `CREATE TABLE "DBX_TEST"."DBX_IOT" 
   (  "ID" NUMBER(10,0), 
  "NAME" VARCHAR2(50), 
   CONSTRAINT "DBX_IOT_PK" PRIMARY KEY ("ID") ENABLE
   ) ORGANIZATION INDEX NOCOMPRESS PCTFREE 10 INITRANS 2 MAXTRANS 255 LOGGING
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS" 
 PCTTHRESHOLD 50 INCLUDING "NAME" OVERFLOW
 PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255 LOGGING
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS";`;

const oracleLobTableDdl = `CREATE TABLE "DBX_TEST"."DBX_LOB" 
   (  "ID" NUMBER(10,0) NOT NULL ENABLE, 
  "DOC" CLOB, 
   CONSTRAINT "DBX_LOB_PK" PRIMARY KEY ("ID")
  USING INDEX PCTFREE 10 INITRANS 2 MAXTRANS 255 
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS"  ENABLE
   ) SEGMENT CREATION IMMEDIATE 
  PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255 NOCOMPRESS LOGGING
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS" 
 LOB ("DOC") STORE AS BASICFILE (
  TABLESPACE "USERS" ENABLE STORAGE IN ROW CHUNK 8192 PCTVERSION 10
  NOCACHE LOGGING 
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT));`;

const oracleQuotedIdentifierDdl = `CREATE TABLE "DBX_TEST"."DBX_QUOTED" 
   (  "PCTFREE" NUMBER(5,0), 
  "LOGGING" VARCHAR2(20), 
  "STORAGE" VARCHAR2(30) DEFAULT 'keep STORAGE(INITIAL 65536)', 
  "ID" NUMBER(10,0) NOT NULL ENABLE, 
   CONSTRAINT "DBX_QUOTED_CK" CHECK (ID > 0) ENABLE, 
   CONSTRAINT "DBX_QUOTED_PK" PRIMARY KEY ("ID")
  USING INDEX PCTFREE 5 INITRANS 2 MAXTRANS 255 
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS"  ENABLE
   ) SEGMENT CREATION IMMEDIATE 
  PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255 NOCOMPRESS LOGGING
  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645
  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1 BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)
  TABLESPACE "USERS";

COMMENT ON TABLE "DBX_TEST"."DBX_QUOTED" IS 'keep STORAGE(INITIAL 65536) text';`;

const oracleSequenceDdl = `
   CREATE SEQUENCE  "DBX_TEST"."DBX_SEQ"  MINVALUE 1 MAXVALUE 9999999999999999999999999999 INCREMENT BY 2 START WITH 5 CACHE 20 NOORDER  NOCYCLE `;

const oracleViewSource = `SELECT ID, "PCTFREE" FROM DBX_QUOTED`;

describe("Oracle DDL storage preference", () => {
  it("drops the physical attributes of a heap table and of its index, keeping the rest verbatim", () => {
    expect(applyDdlStoragePreference(oracleHeapTableDdl, "oracle")).toBe(oracleHeapTableDdlWithoutStorage);
  });

  it("drops index-organized-table storage without touching OVERFLOW, INCLUDING or NOCOMPRESS", () => {
    const logical = applyDdlStoragePreference(oracleIndexOrganizedTableDdl, "oracle");
    expect(logical).not.toContain("STORAGE(");
    expect(logical).not.toContain("PCTFREE");
    expect(logical).not.toContain("PCTUSED");
    expect(logical).not.toContain("INITRANS");
    expect(logical).not.toContain("MAXTRANS");
    expect(logical).not.toContain("PCTTHRESHOLD");
    expect(logical).not.toContain("LOGGING");
    expect(logical).not.toContain('TABLESPACE "USERS"');
    expect(logical).toContain(') ORGANIZATION INDEX NOCOMPRESS INCLUDING "NAME" OVERFLOW;');
  });

  it("drops the LOB storage clause the way SEGMENT_ATTRIBUTES=FALSE does", () => {
    const logical = applyDdlStoragePreference(oracleLobTableDdl, "oracle");
    expect(logical).not.toContain("LOB (");
    expect(logical).not.toContain("STORAGE IN ROW");
    expect(logical).not.toContain("PCTVERSION");
    expect(logical).toContain('"DOC" CLOB');
    expect(logical).toContain('CONSTRAINT "DBX_LOB_PK" PRIMARY KEY ("ID")');
  });

  it("preserves quoted identifiers and string literals that spell storage keywords", () => {
    const logical = applyDdlStoragePreference(oracleQuotedIdentifierDdl, "oracle");
    expect(logical).toContain('"PCTFREE" NUMBER(5,0)');
    expect(logical).toContain('"LOGGING" VARCHAR2(20)');
    expect(logical).toContain("\"STORAGE\" VARCHAR2(30) DEFAULT 'keep STORAGE(INITIAL 65536)'");
    expect(logical).toContain('CONSTRAINT "DBX_QUOTED_CK" CHECK (ID > 0) ENABLE');
    expect(logical).toContain('COMMENT ON TABLE "DBX_TEST"."DBX_QUOTED" IS \'keep STORAGE(INITIAL 65536) text\';');
    expect(logical).not.toContain("STORAGE(INITIAL 65536 NEXT");
    expect(logical).not.toContain('TABLESPACE "USERS"');
  });

  it("leaves DDL without table options untouched", () => {
    expect(applyDdlStoragePreference(oracleSequenceDdl, "oracle")).toBe(oracleSequenceDdl);
    expect(applyDdlStoragePreference(oracleViewSource, "oracle")).toBe(oracleViewSource);
  });

  it("keeps partitioning, constraint state and a named USING INDEX index", () => {
    const ddl = `CREATE TABLE "S"."P_SALES" \n   (  "ID" NUMBER(10,0) NOT NULL ENABLE, \n  "REGION" VARCHAR2(30) \n   )  PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255 NOCOMPRESS LOGGING\n  STORAGE(INITIAL 65536 NEXT 1048576)\n  TABLESPACE "USERS" \n  PARTITION BY RANGE ("ID")\n (PARTITION "P1" VALUES LESS THAN (100) PCTFREE 5 INITRANS 2 STORAGE(INITIAL 65536) TABLESPACE "USERS", \n  PARTITION "P2" VALUES LESS THAN (MAXVALUE) TABLESPACE "USERS")`;
    const logical = applyDdlStoragePreference(ddl, "oracle");
    expect(logical).not.toContain("STORAGE(");
    expect(logical).not.toContain("PCTFREE");
    expect(logical).not.toContain("MAXTRANS");
    expect(logical).not.toContain("LOGGING");
    expect(logical).not.toContain('TABLESPACE "USERS"');
    expect(logical).toContain('PARTITION BY RANGE ("ID")');
    expect(logical).toContain('PARTITION "P1" VALUES LESS THAN (100)');
    expect(logical).toContain('PARTITION "P2" VALUES LESS THAN (MAXVALUE)');
    expect(logical).toContain(") NOCOMPRESS");

    const named = `CREATE TABLE "S"."T" ("A" NUMBER, CONSTRAINT "T_PK" PRIMARY KEY ("A") USING INDEX "T_IDX" ENABLE) PCTFREE 10 TABLESPACE "USERS";`;
    const namedLogical = applyDdlStoragePreference(named, "oracle");
    expect(namedLogical).toContain('USING INDEX "T_IDX" ENABLE');
    expect(namedLogical).not.toContain("PCTFREE");
  });

  it("stops at the query body of a CREATE TABLE AS SELECT", () => {
    const ddl = `CREATE TABLE "S"."C" ("A" NUMBER) PCTFREE 10 TABLESPACE "USERS" AS SELECT COUNT(*), LOGGING, TABLESPACE FROM "S"."SRC";`;
    expect(applyDdlStoragePreference(ddl, "oracle")).toBe(`CREATE TABLE "S"."C" ("A" NUMBER) AS SELECT COUNT(*), LOGGING, TABLESPACE FROM "S"."SRC";`);
    // Without a column list there is no storage region to detect, so the source is returned
    // unchanged instead of guessing where the options end.
    const withoutColumns = `CREATE TABLE "S"."C" PCTFREE 10 TABLESPACE "USERS" AS SELECT LOGGING FROM "S"."SRC";`;
    expect(applyDdlStoragePreference(withoutColumns, "oracle")).toBe(withoutColumns);
  });

  it("returns the raw DDL when disabled and for database types without such attributes", () => {
    expect(applyDdlStoragePreference(oracleHeapTableDdl, "oracle", false)).toBe(oracleHeapTableDdl);
    expect(applyDdlStoragePreference(oracleHeapTableDdl, "postgres")).toBe(oracleHeapTableDdl);
    const broken = `CREATE TABLE "S"."T" ("A" VARCHAR2(10) DEFAULT 'unclosed) PCTFREE 10`;
    expect(applyDdlStoragePreference(broken, "oracle")).toBe(broken);
  });

  it("reports the database types whose DDL carries strippable storage attributes", () => {
    expect(supportsDdlStoragePreference("oracle")).toBe(true);
    expect(supportsDdlStoragePreference("oceanbase-oracle")).toBe(true);
    expect(supportsDdlStoragePreference("mysql")).toBe(false);
    expect(supportsDdlStoragePreference(undefined)).toBe(false);
  });
});

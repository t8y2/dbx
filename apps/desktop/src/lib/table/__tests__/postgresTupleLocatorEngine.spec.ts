import { describe, expect, it } from "vitest";
import { postgresTupleLocatorUnsupportedEngine, shouldIncludeSyntheticRowId } from "@/lib/table/tableEditing";

const connection = (dbType: string, productName?: string, productVersion?: string) => ({
  db_type: dbType,
  database_info: productName || productVersion ? { productName, productVersion } : undefined,
});

describe("postgresTupleLocatorUnsupportedEngine (#14745)", () => {
  it("blocks Greenplum, Cloudberry, and Hologres postgres connections", () => {
    expect(postgresTupleLocatorUnsupportedEngine(connection("postgres", "Greenplum", "PostgreSQL 9.4.24 (Greenplum Database 6.18.2 build commit)"))).toBe(true);
    expect(postgresTupleLocatorUnsupportedEngine(connection("postgres", "Apache Cloudberry", "PostgreSQL 14.4 (Apache Cloudberry 1.2.0)"))).toBe(true);
    // Hologres connections reject tableoid outright (#12647).
    expect(postgresTupleLocatorUnsupportedEngine(connection("postgres", undefined, "PostgreSQL 14.x (Hologres 2.x)"))).toBe(true);
  });

  it("keeps vanilla PostgreSQL and engines without product info on the locator", () => {
    expect(postgresTupleLocatorUnsupportedEngine(connection("postgres", "PostgreSQL", "PostgreSQL 16.2 on x86_64"))).toBe(false);
    expect(postgresTupleLocatorUnsupportedEngine(connection("postgres"))).toBe(false);
    expect(postgresTupleLocatorUnsupportedEngine(undefined)).toBe(false);
    // Non-postgres engine types are decided by their own capability sets.
    expect(postgresTupleLocatorUnsupportedEngine(connection("mysql", "Greenplum", "whatever"))).toBe(false);
  });

  it("gates the synthetic row-id decision for keyless base tables (#14745)", () => {
    const keyless: string[] = [];
    expect(shouldIncludeSyntheticRowId("postgres", keyless, "TABLE")).toBe(true);
    // The engine gate is a separate predicate the injection sites combine; the
    // combination is what keeps Cloudberry AO tables from receiving the
    // tableoid/ctid/xmin projection.
    expect(shouldIncludeSyntheticRowId("postgres", keyless, "TABLE") && !postgresTupleLocatorUnsupportedEngine(connection("postgres", "Apache Cloudberry", "PostgreSQL 14.4 (Apache Cloudberry 1.2.0)"))).toBe(false);
  });
});

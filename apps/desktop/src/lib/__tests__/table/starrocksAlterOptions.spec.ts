import { describe, expect, it } from "vitest";
import { starRocksAlterOptionsFromDdl, starRocksColumnDefinitionLocked, starRocksLayoutDraft, starRocksLayoutChanges } from "@/lib/table/starrocksAlterOptions";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";

describe("StarRocks ALTER metadata", () => {
  const ddl = "CREATE TABLE `events` (\n`id` bigint, `ts` datetime, `value` varchar(100) COMMENT 'PRIMARY KEY(fake)'\n) ENGINE=OLAP\nPRIMARY KEY(`id`, `ts`)\nCOMMENT 'DISTRIBUTED BY HASH(value)'\nPARTITION BY date_trunc('day', `ts`)\nDISTRIBUTED BY HASH(`id`) BUCKETS 8\nPROPERTIES ('x'='y')";
  it("reads table clauses while ignoring parentheses and fake clauses in strings", () => {
    const context = starRocksAlterOptionsFromDdl(ddl, "3.5.0");
    expect(context.model).toBe("primary");
    expect(context.keyColumns).toEqual(["id", "ts"]);
    expect(context.partitionColumns).toContain("ts");
    expect(context.distributionColumns).toContain("id");
    expect(context.distributionColumns).not.toContain("value");
  });
  it("rejects unconfirmed or external table metadata", () => {
    expect(starRocksAlterOptionsFromDdl("").model).toBeUndefined();
    expect(starRocksAlterOptionsFromDdl(ddl.replace("ENGINE=OLAP", "ENGINE=MYSQL")).model).toBeUndefined();
  });
  it("locks protected columns and aggregate/unknown definitions but not ordinary values", () => {
    const context = starRocksAlterOptionsFromDdl(ddl);
    const draft = (name: string) => ({ original: { name } }) as EditableStructureColumn;
    expect(starRocksColumnDefinitionLocked(draft("ts"), context)).toBe(true);
    expect(starRocksColumnDefinitionLocked(draft("id"), context)).toBe(true);
    expect(starRocksColumnDefinitionLocked(draft("value"), context)).toBe(false);
    expect(starRocksColumnDefinitionLocked(draft("value"), { ...context, model: "aggregate" })).toBe(true);
    expect(starRocksColumnDefinitionLocked(draft("value"))).toBe(true);
    expect(starRocksColumnDefinitionLocked({} as EditableStructureColumn)).toBe(false);
  });
  it("separates StarRocks editing capabilities from MySQL and gates rename versions", () => {
    const caps = getTableStructureCapabilities("starrocks", "mysql", "3.5.0");
    expect(caps).toMatchObject({ renameColumn: true, alterDefault: false, alterType: true, alterPrimaryKey: false, addPrimaryKey: false, createIndex: false, foreignKey: false, reorderColumn: false });
    expect(getTableStructureCapabilities("starrocks", "starrocks", "3.3.1").renameColumn).toBe(false);
    expect(getTableStructureCapabilities("starrocks", "starrocks", "3.3.2").renameColumn).toBe(true);
    expect(getTableStructureCapabilities("starrocks").renameColumn).toBe(false);
    expect(getTableStructureCapabilities("mysql").alterPrimaryKey).toBe(true);
  });
});

describe("StarRocks layout draft", () => {
  it("hydrates distribution and preserves a clean draft", () => {
    const context = starRocksAlterOptionsFromDdl('CREATE TABLE `t` (`id` INT) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY HASH(`id`) BUCKETS 8 PROPERTIES("x"="y")', "3.5.8");
    expect(context.distribution).toEqual({ method: "hash", columns: ["id"], buckets: 8 });
    const draft = starRocksLayoutDraft(context)!;
    expect(starRocksLayoutChanges(draft, context)).toBeUndefined();
    draft.bucketCount = "12";
    draft.defaultOnly = true;
    expect(starRocksLayoutChanges(draft, context)?.distribution).toEqual({ method: "hash", columns: ["id"], buckets: 12, defaultOnly: true });
    draft.bucketCount = "1.5";
    expect(starRocksLayoutChanges(draft, context)?.distribution?.buckets).toBe(0);
  });
  it("extracts manual partition keys without mistaking properties or comments for clauses", () => {
    const context = starRocksAlterOptionsFromDdl(
      'CREATE TABLE `t` (`dt` DATE COMMENT "PARTITION BY fake", `city` VARCHAR(20)) ENGINE=OLAP DUPLICATE KEY(`dt`) PARTITION BY LIST(`dt`, `city`) (PARTITION p1 VALUES IN (("2026-01-01", "a"))) DISTRIBUTED BY RANDOM PROPERTIES("colocate_with"="")',
      "3.5.0",
    );
    expect(context.partitionKind).toBe("list");
    expect(context.partitionColumns).toEqual(["dt", "city"]);
    expect(context.partitionClause).toMatch(/^PARTITION BY LIST/);
    expect(context.distribution).toEqual({ method: "random", columns: [], buckets: undefined });
    expect(context.colocated).toBe(false);
  });
});

describe("automatic bucket scaling", () => {
  it("reads positive bucket_size only from actual table properties", () => {
    const base = 'CREATE TABLE `t` (`id` INT COMMENT \'"bucket_size"="99"\') ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM';
    expect(starRocksAlterOptionsFromDdl(base).automaticBucketScaling).toBe(false);
    expect(starRocksAlterOptionsFromDdl(base + ' PROPERTIES("bucket_size"="1073741824")').automaticBucketScaling).toBe(true);
    expect(starRocksAlterOptionsFromDdl(base + ' PROPERTIES("bucket_size"="0")').automaticBucketScaling).toBe(false);
  });
});

describe("StarRocks physical column reordering", () => {
  it.each([
    ["(time_slice(`day`, INTERVAL 7 year, floor), `id`)", ["day"]],
    ["(date_trunc('day', from_unixtime(`ts`)), `id`)", ["ts"]],
    ["(`day`, `id`)", []],
    ["LIST(`day`, `id`) (PARTITION p1 VALUES IN (('2026-01-01', 'id')))", []],
  ])("distinguishes partition-expression sources from plain keys: %s", (partition, expected) => {
    const ddl = "CREATE TABLE `test4` (`day` datetime, `id` varchar(255), `ts` bigint) ENGINE=OLAP DUPLICATE KEY(`day`, `id`) PARTITION BY " + partition + " DISTRIBUTED BY RANDOM";
    const context = starRocksAlterOptionsFromDdl(ddl, "3.5.0");
    expect(context.partitionExpressionColumns).toEqual(expected);
    expect(context.partitionExpressionColumns).not.toContain("id");
  });

  it("uses table-model capabilities and keeps complete schema names including complex types", () => {
    const ddl = "CREATE TABLE `t` (`id` bigint, `attrs` STRUCT<x INT, y VARCHAR(20)>, `value` varchar(20), INDEX idx (`value`) USING BITMAP) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM";
    const context = starRocksAlterOptionsFromDdl(ddl, "3.5.0");
    expect(context.columnNames).toEqual(["id", "attrs", "value"]);
    expect(getTableStructureCapabilities("starrocks", "mysql", "3.5.0", "duplicate").reorderColumn).toBe(true);
    for (const model of ["aggregate", "unique"]) expect(getTableStructureCapabilities("starrocks", "mysql", "3.5.0", model).reorderColumn).toBe(false);
    expect(getTableStructureCapabilities("starrocks", "mysql", "3.5.0", "primary").reorderColumn).toBe(false);
    expect(getTableStructureCapabilities("starrocks", "mysql", "3.5.0").reorderColumn).toBe(false);
  });
});

describe("existing StarRocks sort keys", () => {
  it("reads explicit sort priority independently of field order and falls back to key columns", () => {
    const ddl = 'CREATE TABLE `t` (`id` INT, `dt` DATETIME, `value` INT COMMENT "ORDER BY(fake)") ENGINE=OLAP DUPLICATE KEY(`id`, `dt`) DISTRIBUTED BY RANDOM';
    expect(starRocksAlterOptionsFromDdl(ddl).sortColumns).toEqual(["id", "dt"]);
    expect(starRocksAlterOptionsFromDdl(ddl + " ORDER BY(`dt`, `value`)").sortColumns).toEqual(["dt", "value"]);
    expect(starRocksAlterOptionsFromDdl(ddl + " ORDER BY(`dt`, `value`)").columnNames).toEqual(["id", "dt", "value"]);
  });
});

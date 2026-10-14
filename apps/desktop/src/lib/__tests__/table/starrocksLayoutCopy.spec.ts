import { describe, expect, it, vi } from "vitest";
import { buildStarRocksLayoutCopyDdl, executeStarRocksCopyPlan, starRocksCopyInsertColumns } from "@/lib/table/starrocksLayoutCopy";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";

const source = `CREATE TABLE \`old\` (
  \`id\` bigint NOT NULL COMMENT 'PROPERTIES fake',
  \`dt\` datetime NULL,
  \`amount\` decimal(18, 2) SUM DEFAULT '0'
) ENGINE=OLAP
AGGREGATE KEY(\`id\`, \`dt\`)
COMMENT 'original table'
PARTITION BY RANGE(\`dt\`) (PARTITION p1 VALUES [("2026-01-01"), ("2027-01-01")))
DISTRIBUTED BY RANDOM
ORDER BY(\`dt\`, \`id\`)
PROPERTIES ("bucket_size"="1073741824", "compression"="LZ4", "dynamic_partition.enable"="true", "colocate_with"="g", "unknown"="keep; DISTRIBUTED BY RANDOM");`;
const generated = `CREATE TABLE \`new\` (\`id\` bigint, \`dt\` datetime) PRIMARY KEY(\`id\`) PARTITION BY date_trunc('month', \`dt\`) DISTRIBUTED BY HASH(\`id\`) BUCKETS 16;`;

describe("StarRocks layout copy", () => {
  it("keeps raw columns, actual key model, comments, sorting and unknown properties", () => {
    const ddl = buildStarRocksLayoutCopyDdl(source, generated, "db", "new`table", false);
    expect(ddl).toContain("CREATE TABLE `db`.`new``table` (");
    expect(ddl).toContain("`amount` decimal(18, 2) SUM DEFAULT '0'");
    expect(ddl).toContain("AGGREGATE KEY(`id`, `dt`)");
    expect(ddl).not.toContain("PRIMARY KEY");
    expect(ddl).toContain("COMMENT 'original table'");
    expect(ddl).toContain("PARTITION BY date_trunc('month', `dt`)");
    expect(ddl).toContain("DISTRIBUTED BY HASH(`id`) BUCKETS 16");
    expect(ddl).toContain("ORDER BY(`dt`, `id`)");
    expect(ddl).toContain('"unknown"="keep; DISTRIBUTED BY RANDOM"');
    expect(ddl).toContain('"compression"="LZ4"');
    expect(ddl).not.toContain('"bucket_size"');
    expect(ddl).not.toContain('"colocate_with"');
    expect(ddl).not.toContain('"dynamic_partition.enable"');
  });
  it("preserves manual ranges and retention when requested", () => {
    const ddl = buildStarRocksLayoutCopyDdl(source, generated, "db", "new", true);
    expect(ddl).toContain('PARTITION BY RANGE(`dt`) (PARTITION p1 VALUES [("2026-01-01"), ("2027-01-01")))');
    expect(ddl).toContain('"dynamic_partition.enable"="true"');
  });
  it("inserts or removes partition clauses without corrupting adjacent distribution", () => {
    const unpartitioned = "CREATE TABLE `t` (`id` INT) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY HASH(`id`);";
    const withPartition = buildStarRocksLayoutCopyDdl(unpartitioned, generated, "db", "new", false);
    expect(withPartition.indexOf("PARTITION BY")).toBeLessThan(withPartition.indexOf("DISTRIBUTED BY"));
    const withoutPartition = buildStarRocksLayoutCopyDdl(source, unpartitioned, "db", "new", false);
    expect(withoutPartition).not.toContain("PARTITION BY RANGE");
    expect(withoutPartition).toContain("DISTRIBUTED BY HASH(`id`)");
  });
  it("rejects external tables and multi-statement inputs", () => {
    expect(() => buildStarRocksLayoutCopyDdl(source.replace("ENGINE=OLAP", "ENGINE=MYSQL"), generated, "db", "new", false)).toThrow();
    expect(() => buildStarRocksLayoutCopyDdl(source + "DROP TABLE x;", generated, "db", "new", false)).toThrow();
  });
  it("omits generated columns from explicit data transfer", () => {
    const ddl = "CREATE TABLE `t` (`id` INT, `derived` INT AS (`id` + 1)) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM;";
    expect(starRocksCopyInsertColumns(ddl, [{ name: "id" }, { name: "derived" }] as EditableStructureColumn[])).toEqual(["id"]);
  });
  it("creates first, copies only when selected, and never replays a failed step", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const stages: string[] = [];
    await executeStarRocksCopyPlan({ createSql: "CREATE", insertSql: "INSERT", targetName: "new" }, execute, (stage) => stages.push(stage));
    expect(execute.mock.calls.map((call) => call[0])).toEqual(["CREATE", "INSERT"]);
    expect(stages).toEqual(["creating", "created", "transferring", "complete"]);
    execute.mockClear();
    await executeStarRocksCopyPlan({ createSql: "CREATE", targetName: "empty" }, execute, () => {});
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockReset().mockRejectedValueOnce(new Error("already exists"));
    await expect(executeStarRocksCopyPlan({ createSql: "CREATE", insertSql: "INSERT", targetName: "new" }, execute, () => {})).rejects.toThrow("already exists");
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("load failed"));
    const failedStages: string[] = [];
    await expect(executeStarRocksCopyPlan({ createSql: "CREATE", insertSql: "INSERT", targetName: "new" }, execute, (stage) => failedStages.push(stage))).rejects.toThrow("load failed");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(failedStages).toEqual(["creating", "created", "transferring"]);
  });
});

import { describe, expect, it } from "vitest";
import { buildDorisTableLayout, dorisLayoutFromDdl, dorisPartitionRangeText, dorisPartitionSearchText } from "../dorisLayout";
import type { DorisPartitionInfo } from "@/types/database";

const AGGREGATE_RANGE = `CREATE TABLE \`demo\`.\`orders\` (
  \`order_id\` BIGINT NOT NULL COMMENT '订单号',
  \`dt\` DATE NOT NULL COMMENT '日期',
  \`amount\` DECIMAL(18, 2) SUM COMMENT '金额'
) ENGINE=OLAP
AGGREGATE KEY(\`order_id\`, \`dt\`)
COMMENT '订单表'
PARTITION BY RANGE(\`dt\`)
(
  PARTITION p202401 VALUES [('2024-01-01'), ('2024-02-01')),
  PARTITION p202402 VALUES [('2024-02-01'), ('2024-03-01'))
)
DISTRIBUTED BY HASH(\`order_id\`) BUCKETS 10
PROPERTIES ("replication_num" = "3", "storage_medium" = "SSD");`;

const UNIQUE_AUTO = `CREATE TABLE \`demo\`.\`events\` (
  \`id\` BIGINT NOT NULL,
  \`dt\` DATE NOT NULL
) ENGINE=OLAP
UNIQUE KEY(\`id\`)
AUTO PARTITION BY RANGE(date_trunc(\`dt\`, 'month')) ()
DISTRIBUTED BY HASH(\`id\`) BUCKETS AUTO
PROPERTIES ("dynamic_partition.enable" = "true", "colocate_with" = "g1");`;

const LIST_RANDOM = `CREATE TABLE \`demo\`.\`region_sales\` (
  \`id\` BIGINT NOT NULL,
  \`region\` VARCHAR(32) NOT NULL
) ENGINE=OLAP
UNIQUE KEY(\`id\`, \`region\`)
PARTITION BY LIST(\`region\`)
(PARTITION p_east VALUES IN (('east'), ('east2')))
DISTRIBUTED BY RANDOM BUCKETS 4;`;

const UNPARTITIONED = `CREATE TABLE \`demo\`.\`tiny\` (
  \`id\` BIGINT NOT NULL
) ENGINE=OLAP
DUPLICATE KEY(\`id\`)
DISTRIBUTED BY HASH(\`id\`) BUCKETS 3;`;

describe("dorisLayoutFromDdl", () => {
  it("parses aggregate key, range partitions, hash buckets and properties", () => {
    const layout = dorisLayoutFromDdl(AGGREGATE_RANGE);
    expect(layout.kind).toBe("olap");
    expect(layout.model).toBe("aggregate");
    expect(layout.keyColumns).toEqual(["order_id", "dt"]);
    expect(layout.partition.enabled).toBe(true);
    expect(layout.partition.mode).toBe("range");
    expect(layout.partition.auto).toBe(false);
    expect(layout.partition.columns).toEqual(["dt"]);
    expect(layout.partition.expression).toBeNull();
    expect(layout.distribution).toEqual({ method: "hash", columns: ["order_id"], buckets: 10, autoBuckets: false });
    expect(layout.properties).toEqual({ replication_num: "3", storage_medium: "SSD" });
    expect(layout.dynamicPartition).toBe(false);
    expect(layout.colocateWith).toBeNull();
    expect(layout.warnings).toEqual([]);
  });

  it("parses AUTO PARTITION expression and BUCKETS AUTO without turning them into zero", () => {
    const layout = dorisLayoutFromDdl(UNIQUE_AUTO);
    expect(layout.model).toBe("unique");
    expect(layout.partition).toMatchObject({ enabled: true, mode: "range", auto: true, columns: [] });
    expect(layout.partition.expression).toContain("date_trunc");
    expect(layout.distribution).toEqual({ method: "hash", columns: ["id"], buckets: null, autoBuckets: true });
    expect(layout.dynamicPartition).toBe(true);
    expect(layout.colocateWith).toBe("g1");
  });

  it("parses LIST partitions and RANDOM distribution", () => {
    const layout = dorisLayoutFromDdl(LIST_RANDOM);
    expect(layout.model).toBe("unique");
    expect(layout.partition.mode).toBe("list");
    expect(layout.partition.columns).toEqual(["region"]);
    expect(layout.distribution).toEqual({ method: "random", columns: [], buckets: 4, autoBuckets: false });
  });

  it("keeps an unpartitioned table as an OLAP layout with bucket info", () => {
    const layout = dorisLayoutFromDdl(UNPARTITIONED);
    expect(layout.kind).toBe("olap");
    expect(layout.partition.enabled).toBe(false);
    expect(layout.distribution.method).toBe("hash");
    expect(layout.distribution.buckets).toBe(3);
  });

  it("does not parse partition/distribution keywords from comments or string literals", () => {
    const ddl = `CREATE TABLE \`demo\`.\`t\` (
  \`id\` BIGINT NOT NULL,
  \`note\` VARCHAR(100) DEFAULT 'PARTITION BY RANGE(id) DISTRIBUTED BY HASH(id) BUCKETS 9'
) ENGINE=OLAP
DUPLICATE KEY(\`id\`)
DISTRIBUTED BY HASH(\`id\`) BUCKETS 2;`;
    const layout = dorisLayoutFromDdl(ddl);
    expect(layout.partition.enabled).toBe(false);
    expect(layout.distribution.columns).toEqual(["id"]);
    expect(layout.distribution.buckets).toBe(2);
  });

  it("keeps quoted identifiers containing commas intact", () => {
    const ddl = `CREATE TABLE \`demo\`.\`t\` (
  \`a,b\` BIGINT NOT NULL
) ENGINE=OLAP
DUPLICATE KEY(\`a,b\`)
DISTRIBUTED BY HASH(\`a,b\`) BUCKETS 1;`;
    const layout = dorisLayoutFromDdl(ddl);
    expect(layout.keyColumns).toEqual(["a,b"]);
    expect(layout.distribution.columns).toEqual(["a,b"]);
  });

  it("still reads distribution when the KEY clause is omitted", () => {
    const ddl = `CREATE TABLE \`demo\`.\`t\` (
  \`id\` BIGINT NOT NULL
) ENGINE=OLAP
DISTRIBUTED BY HASH(\`id\`) BUCKETS 5;`;
    const layout = dorisLayoutFromDdl(ddl);
    expect(layout.model).toBeNull();
    expect(layout.distribution).toEqual({ method: "hash", columns: ["id"], buckets: 5, autoBuckets: false });
  });

  it("marks non-OLAP objects", () => {
    const layout = dorisLayoutFromDdl("CREATE VIEW `demo`.`v` AS SELECT 1");
    expect(layout.kind).toBe("nonOlap");
    expect(layout.partition.enabled).toBe(false);
  });

  it("parses the exact SHOW CREATE TABLE shape returned by Doris 4.1.3", () => {
    const range = "CREATE TABLE `orders_range` (\n  `id` bigint NOT NULL,\n  `dt` date NOT NULL,\n  `amount` decimal(18,2) SUM NULL\n) ENGINE=OLAP\nAGGREGATE KEY(`id`, `dt`)\nCOMMENT 'orders'\nPARTITION BY RANGE(`dt`)\n(PARTITION p202401 VALUES [('2024-01-01'), ('2024-02-01')))\nDISTRIBUTED BY HASH(`id`) BUCKETS 3\nPROPERTIES (\n\"replication_allocation\" = \"tag.location.default: 1\",\n\"storage_medium\" = \"hdd\"\n);";
    const rangeLayout = dorisLayoutFromDdl(range);
    expect(rangeLayout.model).toBe("aggregate");
    expect(rangeLayout.partition).toMatchObject({ enabled: true, mode: "range", auto: false, columns: ["dt"], expression: null });
    expect(rangeLayout.distribution).toEqual({ method: "hash", columns: ["id"], buckets: 3, autoBuckets: false });
    expect(rangeLayout.properties.replication_allocation).toBe("tag.location.default: 1");

    const list = "CREATE TABLE `region_list` (\n  `id` bigint NOT NULL,\n  `region` varchar(32) NOT NULL\n) ENGINE=OLAP\nUNIQUE KEY(`id`, `region`)\nPARTITION BY LIST (`region`)\n(PARTITION p_east VALUES IN (\"east\"))\nDISTRIBUTED BY HASH(`id`) BUCKETS 2\nPROPERTIES (\n\"replication_allocation\" = \"tag.location.default: 1\"\n);";
    const listLayout = dorisLayoutFromDdl(list);
    expect(listLayout.model).toBe("unique");
    expect(listLayout.partition).toMatchObject({ enabled: true, mode: "list", columns: ["region"] });
    expect(listLayout.distribution).toEqual({ method: "hash", columns: ["id"], buckets: 2, autoBuckets: false });

    const auto = "CREATE TABLE `events_auto` (\n  `id` bigint NOT NULL,\n  `dt` date NOT NULL\n) ENGINE=OLAP\nUNIQUE KEY(`id`, `dt`)\nAUTO PARTITION BY RANGE (date_trunc(`dt`, 'month'))\n()\nDISTRIBUTED BY HASH(`id`) BUCKETS AUTO\nPROPERTIES (\n\"replication_allocation\" = \"tag.location.default: 1\"\n);";
    const autoLayout = dorisLayoutFromDdl(auto);
    expect(autoLayout.partition).toMatchObject({ enabled: true, mode: "range", auto: true, columns: [] });
    expect(autoLayout.partition.expression).toContain("date_trunc");
    expect(autoLayout.distribution).toEqual({ method: "hash", columns: ["id"], buckets: null, autoBuckets: true });

    const unpartitioned = "CREATE TABLE `tiny_unpartitioned` (\n  `id` bigint NOT NULL\n) ENGINE=OLAP\nDUPLICATE KEY(`id`)\nDISTRIBUTED BY HASH(`id`) BUCKETS 2\nPROPERTIES (\n\"replication_allocation\" = \"tag.location.default: 1\"\n);";
    const unpartitionedLayout = dorisLayoutFromDdl(unpartitioned);
    expect(unpartitionedLayout.partition.enabled).toBe(false);
    expect(unpartitionedLayout.distribution.buckets).toBe(2);
  });

  it("warns instead of accepting a StarRocks PRIMARY KEY model", () => {
    const ddl = `CREATE TABLE \`demo\`.\`t\` (
  \`id\` BIGINT NOT NULL
) ENGINE=OLAP
PRIMARY KEY(\`id\`)
DISTRIBUTED BY HASH(\`id\`) BUCKETS 1;`;
    const layout = dorisLayoutFromDdl(ddl);
    expect(layout.model).toBeNull();
    expect(layout.warnings.join(" ")).toContain("PRIMARY KEY");
  });
});

describe("buildDorisTableLayout", () => {
  const partition: DorisPartitionInfo = {
    partitionId: 1,
    name: "p202401",
    range: "[types: [DATE]; keys: [2024-01-01]; ..types: [DATE]; keys: [2024-02-01]; )",
    buckets: 10,
    replicationNum: 3,
    state: "NORMAL",
    dataSize: "1.2 GB",
    visibleVersion: 8,
  };

  it("merges SHOW PARTITIONS rows into the DDL layout", () => {
    const layout = buildDorisTableLayout(AGGREGATE_RANGE, { supported: true, partitions: [partition] });
    expect(layout.partitions).toHaveLength(1);
    expect(layout.unavailableReason).toBeUndefined();
  });

  it("keeps table-level layout when the catalog is unsupported", () => {
    const layout = buildDorisTableLayout(AGGREGATE_RANGE, { supported: false, reason: "external_catalog", partitions: [] });
    expect(layout.kind).toBe("olap");
    expect(layout.model).toBe("aggregate");
    expect(layout.partitions).toEqual([]);
    expect(layout.unavailableReason).toBe("externalCatalog");
  });

  it("maps a permission failure without discarding table-level layout", () => {
    const layout = buildDorisTableLayout(AGGREGATE_RANGE, null, "Access denied; you need (at least one of) the SHOW privilege");
    expect(layout.model).toBe("aggregate");
    expect(layout.partitions).toEqual([]);
    expect(layout.unavailableReason).toBe("permissionDenied");
    expect(layout.warnings.join(" ")).toContain("Access denied");
  });

  it("marks non-OLAP results as notOlap", () => {
    const layout = buildDorisTableLayout("CREATE VIEW `demo`.`v` AS SELECT 1", { supported: true, partitions: [] });
    expect(layout.unavailableReason).toBe("notOlap");
  });
});

describe("partition display helpers", () => {
  it("collapses Range whitespace without inventing a SQL interval", () => {
    expect(dorisPartitionRangeText("  [types: [DATE];\n keys: [2024-01-01]; ) ")).toBe("[types: [DATE]; keys: [2024-01-01]; )");
    expect(dorisPartitionRangeText(null)).toBe("");
  });

  it("builds a lowercase search string from the useful fields", () => {
    expect(dorisPartitionSearchText({ name: "P202401", range: "[2024-01-01, 2024-02-01)", state: "NORMAL" })).toContain("p202401");
    expect(dorisPartitionSearchText({ name: "P202401", range: null, state: null })).toBe("p202401");
  });
});

import { describe, expect, it } from "vitest";
import { readPaimonCopySource, paimonCopyDdl } from "@/lib/table/starrocksLayoutCopy";
import { paimonWriteExpression, emptyTablePhysicalOptions } from "@/lib/table/tablePhysicalOptions";

describe("Paimon repartitioning", () => {
  it("preserves column defaults and comments, replaces the partition, and isolates storage", () => {
    const source = readPaimonCopySource("CREATE TABLE ods.t (`id` BIGINT, dt DATE, label STRING DEFAULT 'a,b') USING paimon PARTITIONED BY (`dt`) COMMENT 'orders' LOCATION '/old' TBLPROPERTIES ('bucket'='4','primary-key'='id,dt')");
    expect(source.partitionNames).toEqual(["dt"]);
    expect(source.properties.get("bucket")).toBe("4");
    const sql = paimonCopyDdl(source, "CREATE TABLE t (id BIGINT, dt DATE, label STRING, p_year INT GENERATED ALWAYS AS (YEAR(dt))) PARTITIONED BY (p_year) TBLPROPERTIES ('bucket'='4', 'primary-key'='id,dt,p_year');", "`ods`.`t_new`", true);
    expect(sql).toContain("label STRING DEFAULT 'a,b', p_year INT GENERATED ALWAYS AS (YEAR(dt))");
    expect(sql).toContain("USING paimon PARTITIONED BY (p_year) COMMENT 'orders'");
    expect(sql).not.toContain("/old");
  });
  it("replaces the old month definition while preserving surrounding columns", () => {
    const source = readPaimonCopySource("CREATE TABLE t (id BIGINT, `p_month` DATE, dt DATE COMMENT 'a,b') USING paimon PARTITIONED BY (p_month)");
    const sql = paimonCopyDdl(source, "CREATE TABLE n (id BIGINT, dt DATE, p_month DATE COMMENT 'new') PARTITIONED BY (p_month)", "n", true, "p_month");
    expect(sql).toContain("dt DATE COMMENT 'a,b', p_month DATE COMMENT 'new'");
    expect(sql).not.toContain("`p_month` DATE");
  });
  it("computes half-open integer ranges and rejects overlaps", () => {
    const draft = { ...emptyTablePhysicalOptions(), partitionMode: "range" as const, partitionRanges: [{ name: "p1", lower: "0", upper: "10" }] };
    expect(paimonWriteExpression(draft, "id")).toContain("id >= 0 AND id < 10");
    draft.partitionRanges.push({ name: "p2", lower: "9", upper: "20" });
    expect(() => paimonWriteExpression(draft, "id")).toThrow();
  });
});

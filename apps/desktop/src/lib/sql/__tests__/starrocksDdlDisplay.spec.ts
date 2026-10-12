import { describe, expect, it } from "vitest";
import { formatStarRocksDdlForDisplay } from "../starrocksDdlDisplay";
import { formatDdlForDisplay } from "../ddlDisplay";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

const source =
  'CREATE TABLE `test4` (`day` datetime NULL COMMENT "", `id` VARCHAR(255) NOT NULL COMMENT "", `price1` DECIMAL(7, 0) NULL COMMENT "工资, PROPERTIES (x)") ENGINE = OLAP DUPLICATE KEY(`day`, `id`) PARTITION BY (time_slice (`day`, INTERVAL 7 YEAR, floor), `id`) DISTRIBUTED BY RANDOM PROPERTIES("bucket_size" = "1073741824", "compression" = "LZ4");';
const expected = `CREATE TABLE \`test4\` (
  \`day\` datetime NULL COMMENT "",
  \`id\` varchar(255) NOT NULL COMMENT "",
  \`price1\` decimal(7, 0) NULL COMMENT "工资, PROPERTIES (x)"
) ENGINE=OLAP
DUPLICATE KEY(\`day\`, \`id\`)
PARTITION BY (time_slice(\`day\`, INTERVAL 7 year, floor), \`id\`)
DISTRIBUTED BY RANDOM
PROPERTIES (
"bucket_size" = "1073741824",
"compression" = "LZ4"
);`;

describe("StarRocks DDL display", () => {
  it("keeps nested expressions and string contents while separating table clauses", () => {
    expect(formatStarRocksDdlForDisplay(source)).toBe(expected);
    expect(formatStarRocksDdlForDisplay(expected)).toBe(expected);
  });
  it("uses the StarRocks branch through the shared display interface", async () => {
    expect(await formatDdlForDisplay(source, { dialect: "mysql", databaseType: "starrocks", includeDatabaseName: false, quoteIdentifiers: true })).toBe(expected);
  });
  it.each([
    { db_type: "starrocks", driver_profile: "starrocks" },
    { db_type: "mysql", driver_profile: "starrocks" },
    { db_type: "mysql", driver_profile: "StarRocks" },
  ] as const)("formats the effective StarRocks type for $db_type / $driver_profile", async (connection) => {
    const databaseType = effectiveDatabaseTypeForConnection(connection);
    expect(databaseType).toBe("starrocks");
    expect(await formatDdlForDisplay(source, { dialect: "mysql", databaseType, includeDatabaseName: false, quoteIdentifiers: true })).toBe(expected);
  });
  it("does not treat ordinary MySQL as StarRocks", () => {
    expect(effectiveDatabaseTypeForConnection({ db_type: "mysql", driver_profile: "mysql" })).toBe("mysql");
  });
  it("preserves unfamiliar statements and comments", () => {
    for (const sql of ["ALTER TABLE `t` RENAME COLUMN `x` TO `y`;", "CREATE TABLE `t` (`id` INT /* retain comment */);", "CREATE TABLE `t` (`id` INT); DROP TABLE `t`;"]) {
      expect(formatStarRocksDdlForDisplay(sql)).toBe(sql);
    }
  });
});

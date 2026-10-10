import { describe, expect, it } from "vitest";
import { formatStarRocksDdlForDisplay } from "../starrocksDdlDisplay";
import { formatDdlForDisplay } from "../ddlDisplay";

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
  it("preserves unfamiliar statements and comments", () => {
    for (const sql of ["ALTER TABLE `t` RENAME COLUMN `x` TO `y`;", "CREATE TABLE `t` (`id` INT /* retain comment */);", "CREATE TABLE `t` (`id` INT); DROP TABLE `t`;"]) {
      expect(formatStarRocksDdlForDisplay(sql)).toBe(sql);
    }
  });
});

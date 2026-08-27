import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import { mysqlTableEngineDraft, mysqlTableEngineSqlOption, mysqlTableEngineSql, parseMysqlTableEngineMetadata, refreshMysqlTableEngineDraft, supportsMysqlTableEngine } from "@/lib/table/mysqlTableEngine";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("mysqlTableEngine", () => {
  it("builds mode-independent metadata SQL for quoted and Unicode names", () => {
    const sql = mysqlTableEngineSql("db'x", "订单\\archive");
    expect(sql).toContain("TABLE_SCHEMA = CONVERT(X'64622778' USING utf8mb4)");
    expect(sql).toContain("TABLE_NAME = CONVERT(X'e8aea2e58d955c61726368697665' USING utf8mb4)");
    expect(sql).not.toContain("db'x");
  });

  it("keeps supported engines, the server default, and the current table engine", () => {
    const engines = result(
      ["Engine", "Support", "Comment"],
      [
        ["InnoDB", "DEFAULT", ""],
        ["MyISAM", "YES", ""],
        ["FEDERATED", "NO", ""],
      ],
    );
    const table = result(["engine"], [["FEDERATED"]]);

    expect(parseMysqlTableEngineMetadata(engines, table)).toEqual({
      currentEngine: "FEDERATED",
      defaultEngine: "InnoDB",
      engines: ["FEDERATED", "InnoDB", "MyISAM"],
    });
  });

  it("uses the default for a new table and preserves a dirty edit across refresh", () => {
    const initial = { currentEngine: "MyISAM", defaultEngine: "InnoDB", engines: ["InnoDB", "MyISAM"] };
    expect(mysqlTableEngineDraft(initial, true)).toEqual({ value: "InnoDB", originalValue: "InnoDB" });
    expect(mysqlTableEngineDraft(initial, false)).toEqual({ value: "MyISAM", originalValue: "MyISAM" });

    expect(refreshMysqlTableEngineDraft({ ...initial, currentEngine: "InnoDB" }, { value: "ARCHIVE", originalValue: "MyISAM" }, false, true)).toEqual({
      value: "ARCHIVE",
      originalValue: "InnoDB",
    });
  });

  it("sends the selected engine for creates and only changed engines for edits", () => {
    expect(mysqlTableEngineSqlOption({ value: "InnoDB", originalValue: "InnoDB" }, true, true)).toBe("InnoDB");
    expect(mysqlTableEngineSqlOption({ value: "innodb", originalValue: "InnoDB" }, false, true)).toBeUndefined();
    expect(mysqlTableEngineSqlOption({ value: "MyISAM", originalValue: "InnoDB" }, false, true)).toBe("MyISAM");
    expect(mysqlTableEngineSqlOption({ value: "MyISAM", originalValue: "InnoDB" }, false, false)).toBeUndefined();
  });

  it("is limited to native MySQL connections", () => {
    expect(supportsMysqlTableEngine({ db_type: "mysql", driver_profile: "mysql" })).toBe(true);
    expect(supportsMysqlTableEngine({ db_type: "mysql", driver_profile: undefined })).toBe(true);
    expect(supportsMysqlTableEngine({ db_type: "jdbc", driver_profile: "mysql" })).toBe(false);
    expect(supportsMysqlTableEngine({ db_type: "mysql", driver_profile: "goldendb" })).toBe(false);
  });
});

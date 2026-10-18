import { describe, expect, it } from "vitest";
import { mysqlDataCharset, mysqlDataCharsetEnabled, mysqlDataCharsetValidation, setMysqlDataCharset, mysqlDataCharsetAllowsExport, mysqlDataCharsetChanged, mysqlDataCharsetChangeBlocked } from "../mysqlDataCharset";
import type { QueryTab } from "@/types/database";

describe("MySQL data charset", () => {
  it("only retires a session for a semantic codec change", () => {
    expect(mysqlDataCharsetChanged({ db_type: "mysql", url_params: "dataCharset=gbk" }, { db_type: "mysql", url_params: "dataCharset=GBK&timeout=20" })).toBe(false);
    expect(mysqlDataCharsetChanged({ db_type: "firebird", url_params: "dataCharset=gbk" }, { db_type: "firebird", url_params: "dataCharset=BIG5" })).toBe(false);
    expect(mysqlDataCharsetChanged({ db_type: "mysql", url_params: "dataCharset=GBK" }, { db_type: "mysql" })).toBe(true);
  });
  it("preserves drafts by refusing a codec change while any old result or editable view remains", () => {
    const draft = { connectionId: "legacy", mode: "query", sql: "unsaved SQL", isExecuting: false } as QueryTab;
    expect(mysqlDataCharsetChangeBlocked([draft], "legacy")).toBe(false);
    for (const state of [{ mode: "data" }, { mode: "structure" }, { isExecuting: true }, { isExplaining: true }, { txnSessionId: "txn" }, { autoCommitOpenTransaction: true }, { resultCacheState: "disk" }, { resultSessionId: "cursor" }, { result: { rows: [] } }]) {
      expect(mysqlDataCharsetChangeBlocked([{ ...draft, ...state } as QueryTab], "legacy")).toBe(true);
      expect(mysqlDataCharsetChangeBlocked([{ ...draft, ...state } as QueryTab], "other")).toBe(false);
    }
  });
  it("round trips edits and removes only its own option for default", () => {
    const saved = setMysqlDataCharset("?charset=utf8mb4&timeout=10", "gbk");
    expect(mysqlDataCharset(saved)).toBe("GBK");
    expect(setMysqlDataCharset(saved, "default")).toBe("charset=utf8mb4&timeout=10");
    expect(setMysqlDataCharset("DATACHARSET=gbk&dataCharset=big5&timeout=10", "GB18030")).toBe("timeout=10&dataCharset=GB18030");
  });
  it.each(["GBK", "gb18030", "bIg5"])("accepts explicit %s without changing session settings", (codec) => {
    expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params: `dataCharset=${codec}` })).toBeUndefined();
    expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params: `charset=UTF8MB4&dataCharset=${codec}` })).toBeUndefined();
  });
  it.each(["dataCharset=unknown", "dataCharset=", "dataCharset", "dataCharset=%20GBK%20", "dataCharset=GBK+", "dataCharset=GBK&dataCharset=BIG5", "DATACHARSET=GBK&dataCharset=GBK"])("rejects ambiguous or unsupported options: %s", (url_params) => {
    expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params })).toBe("connection.mysqlDataCharsetInvalid");
  });
  it.each(["latin1", "gbk", "utf8", ""])("rejects conflicting explicit charset=%s", (charset) => {
    expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params: `dataCharset=GBK&charset=${charset}` })).toBe("connection.mysqlDataCharsetConflict");
  });
  it("leaves non-MySQL and disabled configurations unchanged", () => {
    for (const driver_profile of ["mariadb", "tidb", "dolt"]) {
      const config = { db_type: "mysql" as const, driver_profile, url_params: "dataCharset=GBK" };
      expect(mysqlDataCharsetEnabled(config)).toBe(false);
      expect(mysqlDataCharsetValidation(config)).toBe("connection.mysqlDataCharsetUnsupported");
    }
    for (const driver_profile of [undefined, "", "mysql", " MySQL "]) expect(mysqlDataCharsetEnabled({ db_type: "mysql", driver_profile, url_params: "dataCharset=GBK" })).toBe(true);
    for (const db_type of ["postgres", "jdbc", "firebird", "doris"] as const) {
      expect(mysqlDataCharsetEnabled({ db_type, url_params: "dataCharset=GBK" })).toBe(false);
      expect(mysqlDataCharsetValidation({ db_type, url_params: "dataCharset=OTHER&charset=latin1" })).toBeUndefined();
    }
    expect(mysqlDataCharsetEnabled({ db_type: "mysql" })).toBe(false);
    expect(mysqlDataCharsetEnabled({ db_type: "mysql", url_params: "dataCharset=" })).toBe(true);
    expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params: "charset=latin1" })).toBeUndefined();
  });
  it("decodes encoded keys/values and rejects session overrides", () => {
    expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params: "%64ataCharset=%47BK&charset=%75tf8mb4" })).toBeUndefined();
    expect(mysqlDataCharsetEnabled({ db_type: "mysql", url_params: "%64ataCharset=GBK" })).toBe(true);
    expect(mysqlDataCharsetEnabled({ db_type: "mysql", url_params: "%20dataCharset%20=GBK" })).toBe(true);
    expect(setMysqlDataCharset("%20dataCharset%20=GBK&timeout=10", "default")).toBe("timeout=10");
    for (const suffix of ["charset=utf8mb4&charset=utf8mb4", "sessionVariables=sql_mode=ANSI", "setupMode=bare", "setup_mode=proxy", "proxySql", "proxySql=", "proxySql=true", "proxySql=%20true%20", "proxySql=yes", "proxySql=1", "proxySql=on"]) {
      expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params: `dataCharset=GBK&${suffix}` })).toBe("connection.mysqlDataCharsetConflict");
    }
    expect(mysqlDataCharsetValidation({ db_type: "mysql", url_params: "dataCharset=GBK&setupMode=standard&sessionVariables=&proxySql=false" })).toBeUndefined();
  });
  it("limits presentation export formats while default behavior stays unchanged", () => {
    for (const format of ["csv", "json", "xlsx"]) expect(mysqlDataCharsetAllowsExport(true, format)).toBe(true);
    for (const format of ["sql", "txt", "markdown", "html"]) {
      expect(mysqlDataCharsetAllowsExport(true, format)).toBe(false);
      expect(mysqlDataCharsetAllowsExport(false, format)).toBe(true);
    }
  });
});

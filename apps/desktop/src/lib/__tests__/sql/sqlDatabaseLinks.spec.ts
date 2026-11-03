import { describe, expect, it } from "vitest";
import { extractSqlParameters, substituteSqlParameters } from "@/lib/sql/sqlParameters";
import { expandSqlVariables } from "@/lib/sql/sqlVariables";

describe.each(["oracle", "oceanbase-oracle"] as const)("%s remote object parameters", (databaseType) => {
  it.each([
    "BEGIN MERGE INTO local_t t USING app.remote_t@LINK s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.v=@value; END;",
    "SELECT seq.NEXTVAL@LINK, @value FROM dual",
    "SELECT app.seq.CURRVAL@LINK, @value FROM dual",
    "CREATE SYNONYM local_t FOR app.remote_t@LINK; SELECT @value FROM dual",
    "MERGE INTO local_t t USING app.remote_t@LINK s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.v=@value",
  ])("preserves database links in %s", (sql) => {
    const options = { databaseType };
    expect(extractSqlParameters(sql, options)).toEqual(["value"]);
    expect(substituteSqlParameters(sql, { value: { kind: "number", value: "7" }, LINK: { kind: "string", value: "wrong" } }, options)).toContain("@LINK");
    const expanded = expandSqlVariables(`@set LINK = wrong;\n@set value = 7;\n${sql}`, options);
    expect(expanded.sql).toBe(sql.replace("@value", "7"));
  });
});

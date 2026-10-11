import { describe, expect, it } from "vitest";
import { classifySqlRisk, splitSqlStatementsForSafety, sqlSafetyText } from "@/lib/sql/sqlRisk";
import { classifyAiSqlExecution } from "@/lib/ai/aiSqlExecutionPolicy";
import type { ConnectionConfig } from "@/types/database";

/**
 * `#` line comments and backslash-escaped quotes are MySQL lexer features.
 * Applying them to every dialect hid statements from the classifier, so a write
 * placed after a SQL Server `#temp` reference or a PostgreSQL `'dir\'` string was
 * read as comment/string content and the whole script was auto-executed.
 */
const sqlServerConnection: ConnectionConfig = {
  id: "conn-sqlserver",
  name: "Reporting",
  db_type: "sqlserver",
  host: "db.internal",
  port: 1433,
  username: "app",
  password: "",
};

const postgresConnection: ConnectionConfig = {
  id: "conn-postgres",
  name: "Reporting",
  db_type: "postgres",
  host: "db.internal",
  port: 5432,
  username: "app",
  password: "",
};

describe("SQL risk dialect lexer rules", () => {
  it("keeps the SQL Server DELETE after a #temp reference", () => {
    const sql = "SELECT * FROM #tmp; DELETE FROM #tmp;";

    expect(sqlSafetyText(sql, "sqlserver")).toContain("DELETE FROM #tmp");
    expect(splitSqlStatementsForSafety(sql, "sqlserver")).toEqual(["SELECT * FROM #tmp", "DELETE FROM #tmp"]);
    expect(classifySqlRisk(sql, { dialect: "sqlserver" }).risk).toBe("write");
  });

  it("does not auto-execute a SQL Server write hidden behind a #temp reference", () => {
    const sql = "SELECT * FROM #tmp; DELETE FROM #tmp;";

    expect(classifyAiSqlExecution(sql, sqlServerConnection)).toMatchObject({
      action: "confirm",
      category: "write",
    });
  });

  it("keeps the PostgreSQL DELETE after a string that ends in a backslash", () => {
    const sql = "SELECT 'dir\\'; DELETE FROM users;";

    expect(sqlSafetyText(sql, "postgres")).toContain("DELETE FROM users");
    // The classifier blanks out literals, so only the DELETE text has to survive.
    expect(splitSqlStatementsForSafety(sql, "postgres")).toEqual(["SELECT", "DELETE FROM users"]);
    expect(classifySqlRisk(sql, { dialect: "postgres" }).risk).toBe("write");
  });

  it("does not auto-execute a PostgreSQL write hidden behind a backslash string", () => {
    const sql = "SELECT 'dir\\'; DELETE FROM users;";

    expect(classifyAiSqlExecution(sql, postgresConnection)).toMatchObject({
      action: "confirm",
      category: "write",
    });
  });

  it("scans PostgreSQL escape strings by the dialect lexer rules", () => {
    // Inside E'...' a backslash escapes the quote, so the DELETE stays literal
    // data and must not raise the risk (matches the Rust scanner).
    const inside = "SELECT E'it\\'s; DELETE FROM users;'";

    expect(sqlSafetyText(inside, "postgres")).not.toContain("DELETE FROM users");
    expect(classifySqlRisk(inside, { dialect: "postgres" }).risk).toBe("read");

    // Outside the E-string the DELETE is real code and must be classified.
    const after = "SELECT E'it\\'s'; DELETE FROM users;";

    expect(sqlSafetyText(after, "postgres")).toContain("DELETE FROM users");
    expect(splitSqlStatementsForSafety(after, "postgres")).toEqual(["SELECT E", "DELETE FROM users"]);
    expect(classifySqlRisk(after, { dialect: "postgres" }).risk).toBe("write");
    expect(classifySqlRisk(after, { dialect: "kingbase" }).risk).toBe("write");
  });

  it("does not auto-execute a PostgreSQL write hidden behind an escape string", () => {
    const sql = "SELECT E'it\\'s'; DELETE FROM users;";

    expect(classifyAiSqlExecution(sql, postgresConnection)).toMatchObject({
      action: "confirm",
      category: "write",
    });
  });

  it("keeps an E that ends an identifier out of the escape-string rules", () => {
    // `xE` is one identifier, so the following literal is ordinary (same as
    // `ends_with_escape_string_prefix` in the Rust scanner).
    const sql = "SELECT xE'it\\'s'; DELETE FROM users;";

    expect(sqlSafetyText(sql, "postgres")).not.toContain("DELETE FROM users");
  });

  it("still reads # as a line comment on MySQL", () => {
    const sql = "SELECT * FROM #tmp; DELETE FROM #tmp;";

    expect(sqlSafetyText(sql, "mysql")).not.toContain("DELETE FROM #tmp");
    expect(splitSqlStatementsForSafety(sql, "mysql")).toEqual(["SELECT * FROM"]);
  });

  it("still honours backslash-escaped quotes on MySQL", () => {
    const sql = "INSERT INTO notes VALUES ('it\\'s; still one value'); SELECT 1;";

    // The semicolon inside the escaped string must not split the statement; the
    // literal itself is blanked out by the classifier.
    expect(splitSqlStatementsForSafety(sql, "mysql")).toEqual(["INSERT INTO notes VALUES ( )", "SELECT 1"]);
  });

  it("fails closed for an unknown dialect", () => {
    const sql = "SELECT * FROM #tmp; DELETE FROM #tmp;";

    expect(splitSqlStatementsForSafety(sql)).toEqual(["SELECT * FROM #tmp", "DELETE FROM #tmp"]);
    expect(classifySqlRisk(sql).risk).toBe("write");
  });
});

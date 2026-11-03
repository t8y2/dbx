import { describe, expect, it } from "vitest";
import { expandSqlVariables } from "@/lib/sql/sqlVariables";

describe("expandSqlVariables", () => {
  it("returns the SQL unchanged when there is no @set declaration", () => {
    const sql = "select * from t where id = @id";
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  it("inlines a declared IN-list verbatim across the script", () => {
    const sql = ["@set client_id = (606,322,634);", "select * from invoices where client_id in @client_id"].join("\n");
    const { sql: result, expanded } = expandSqlVariables(sql);
    expect(expanded).toBe(true);
    expect(result).toBe("select * from invoices where client_id in (606,322,634)");
  });

  it("inlines a quoted string value verbatim", () => {
    const sql = ["@set date_start = '2026-07-04 00:00:00';", "select * from t where created_at < @date_start"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from t where created_at < '2026-07-04 00:00:00'");
  });

  it("inlines a declared shell-style reference", () => {
    const sql = ["@set postid = '224';", "select * from t where post_id = ${postid}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from t where post_id = '224'");
  });

  it("recognizes a declaration after a leading line comment", () => {
    const sql = ["-- saved query", "@set devid=7062;", "select * from t where device_id = ${devid}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("-- saved query\nselect * from t where device_id = 7062");
  });

  it("recognizes declarations after comments at a statement boundary", () => {
    const sql = ["select 1;", "/* next statement */", "@set devid = 7062;", "select ${devid}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1;\n/* next statement */\nselect 7062");
  });

  it("does not recognize a declaration after an unterminated statement", () => {
    const sql = ["select 1", "-- same statement", "@set devid = 7062;", "select ${devid}"].join("\n");
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  it("uses declarations from the surrounding document for a selected statement", () => {
    const selectedSql = "select * from t where post_id = ${postid}";
    const declarationSql = ["@set postid = '224';", selectedSql].join("\n");
    expect(expandSqlVariables(selectedSql, { declarationSql }).sql).toBe("select * from t where post_id = '224'");
  });

  it("leaves undeclared shell-style references for parameter prompting", () => {
    const sql = ["@set postid = '224';", "select ${postid}, ${missing}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select '224', ${missing}");
  });

  it("expands the same variable in multiple places", () => {
    const sql = ["@set tenant = 42;", "select @tenant, count(*) from t where tenant_id = @tenant"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 42, count(*) from t where tenant_id = 42");
  });

  it("supports several declarations", () => {
    const sql = ["@set a = 1;", "@set b = 'x';", "select @a, @b"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, 'x'");
  });

  it("leaves undeclared @name references untouched", () => {
    const sql = ["@set a = 1;", "select @a, @b, @@version"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, @b, @@version");
  });

  it("does not expand references inside strings, comments, or quoted identifiers", () => {
    const sql = ["@set a = 1;", "select '@a' as s, \"@a\" as q, `@a` as b -- @a"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select '@a' as s, \"@a\" as q, `@a` as b -- @a");
  });

  it("does not treat @set inside a string as a declaration", () => {
    const sql = "select '@set a = 1;' as note, @a";
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  describe.each(["dameng", "oracle", "oceanbase-oracle"] as const)("%s database links", (databaseType) => {
    it.each(["", " ", "\t", "\n", "/* @ignored */", " /* first */ \n /* second */ ", "-- @ignored\n"])("preserves a link separated by %j while expanding same-name references", (separator) => {
      const target = `SELECT @Dm1 FROM test.table_name${separator}@dM1 WHERE id = @DM1 AND tenant_id = \${dm1}`;
      const expected = `SELECT 7 FROM test.table_name${separator}@dM1 WHERE id = 7 AND tenant_id = 7`;
      expect(expandSqlVariables(`@set DM1 = 7;\n${target}`, { databaseType })).toEqual({ sql: expected, expanded: true });
      expect(expandSqlVariables(target, { databaseType, declarationSql: `@set DM1 = 7;\n${target}` })).toEqual({ sql: expected, expanded: true });
    });

    it.each(['"Hr"."Audit Log"', '"SELECT"', "订单"])("preserves quoted and Unicode object %s", (objectName) => {
      const target = `SELECT @dm1 FROM ${objectName} /* separator */ @dm1 WHERE id = @dm1`;
      expect(expandSqlVariables(`@set dm1 = 7;\n${target}`, { databaseType }).sql).toBe(`SELECT 7 FROM ${objectName} /* separator */ @dm1 WHERE id = 7`);
    });

    it.each([
      ["SELECT XMLSERIALIZE(CONTENT @value AS CLOB) FROM DUAL", "XMLTYPE('<a/>')", "SELECT XMLSERIALIZE(CONTENT XMLTYPE('<a/>') AS CLOB) FROM DUAL"],
      ["SELECT XMLSERIALIZE(CONTENT@value AS CLOB) FROM DUAL", "XMLTYPE('<a/>')", "SELECT XMLSERIALIZE(CONTENTXMLTYPE('<a/>') AS CLOB) FROM DUAL"],
      ["SELECT XMLSERIALIZE(DOCUMENT @value AS CLOB) FROM DUAL", "XMLTYPE('<a/>')", "SELECT XMLSERIALIZE(DOCUMENT XMLTYPE('<a/>') AS CLOB) FROM DUAL"],
      ["CREATE OR REPLACE PACKAGE BODY @value AS PROCEDURE p IS BEGIN NULL; END; END;", "test_package", "CREATE OR REPLACE PACKAGE BODY test_package AS PROCEDURE p IS BEGIN NULL; END; END;"],
      ["DROP DATABASE LINK @value", "remote_db", "DROP DATABASE LINK remote_db"],
      ["CREATE DATABASE LINK @value CONNECT TO remote_user IDENTIFIED BY password USING 'remote'", "remote_db", "CREATE DATABASE LINK remote_db CONNECT TO remote_user IDENTIFIED BY password USING 'remote'"],
      ['SELECT "xml_column" @value FROM DUAL', "AS xml_alias", 'SELECT "xml_column" AS xml_alias FROM DUAL'],
    ])("expands real templates outside object references in %s", (target, value, expected) => {
      expect(expandSqlVariables(`@set value = ${value};\n${target}`, { databaseType }).sql).toBe(expected);
      expect(expandSqlVariables(target, { databaseType, declarationSql: `@set value = ${value};` }).sql).toBe(expected);
    });

    it.each([
      ["SELECT XMLSERIALIZE(CONTENT @fn('<a/>') AS CLOB) FROM DUAL", "SELECT XMLSERIALIZE(CONTENT XMLTYPE('<a/>') AS CLOB) FROM DUAL"],
      ["SELECT XMLSERIALIZE(DOCUMENT @fn('<a/>') AS CLOB) FROM DUAL", "SELECT XMLSERIALIZE(DOCUMENT XMLTYPE('<a/>') AS CLOB) FROM DUAL"],
      ["SELECT XMLQUERY('/a' PASSING @fn('<a/>') RETURNING CONTENT) FROM DUAL", "SELECT XMLQUERY('/a' PASSING XMLTYPE('<a/>') RETURNING CONTENT) FROM DUAL"],
      ["SELECT XMLQUERY(fn_nested('/a') PASSING @fn('<a/>') RETURNING CONTENT) FROM DUAL", "SELECT XMLQUERY(fn_nested('/a') PASSING XMLTYPE('<a/>') RETURNING CONTENT) FROM DUAL"],
    ])("expands SQL/XML function-name templates in %s", (target, expected) => {
      const declarationSql = `@set fn = XMLTYPE;\n${target}`;
      expect(expandSqlVariables(declarationSql, { databaseType }).sql).toBe(expected);
      expect(expandSqlVariables(target, { databaseType, declarationSql }).sql).toBe(expected);
    });

    it.each([
      "SELECT XMLQUERY('/a' PASSING BY VALUE @fn('<a/>') RETURNING CONTENT) FROM DUAL",
      "SELECT XMLTABLE('/a' PASSING @fn('<a/>') COLUMNS name VARCHAR2(50) PATH '.') FROM DUAL",
      "SELECT XMLTABLE('/a' PASSING BY /* separator */ VALUE @fn('<a/>') COLUMNS name VARCHAR2(50) PATH '.') FROM DUAL",
      "SELECT XMLQUERY('/a' PASSING BY VALUE @fn('<a/>'), @fn('<b/>') AS b RETURNING CONTENT) FROM DUAL",
    ])("expands complete SQL/XML PASSING templates in full and selected SQL in %s", (target) => {
      const declarationSql = `@set fn = XMLTYPE;\n${target}`;
      const expected = target.replaceAll("@fn", "XMLTYPE");
      expect(expandSqlVariables(declarationSql, { databaseType }).sql).toBe(expected);
      expect(expandSqlVariables(target, { databaseType, declarationSql }).sql).toBe(expected);
    });

    it("preserves SQL/XML keyword-named remote routines with a same-name declaration", () => {
      const target = 'SELECT content@LINK(1), document@LINK(1), passing@LINK(1), HR.content@LINK(1), "CONTENT"@LINK(1) FROM DUAL WHERE id = @LINK';
      expect(expandSqlVariables(`@set LINK = 7;\n${target}`, { databaseType }).sql).toBe('SELECT content@LINK(1), document@LINK(1), passing@LINK(1), HR.content@LINK(1), "CONTENT"@LINK(1) FROM DUAL WHERE id = 7');
    });

    it.each([
      "SELECT XMLSERIALIZE(CONTENT content@LINK(1) AS CLOB) FROM DUAL",
      "SELECT XMLSERIALIZE(DOCUMENT document@LINK(1) AS CLOB) FROM DUAL",
      "SELECT XMLQUERY('/a' PASSING passing@LINK(1) RETURNING CONTENT) FROM DUAL",
      "SELECT XMLQUERY(passing@LINK(1)) FROM DUAL",
      "SELECT XMLQUERY(fn_nested('/a') PASSING passing@LINK(1) RETURNING CONTENT) FROM DUAL",
      "SELECT XMLQUERY('/a' PASSING BY VALUE value@LINK(1) RETURNING CONTENT) FROM DUAL",
      "SELECT XMLTABLE('/a' PASSING passing@LINK(1) COLUMNS name VARCHAR2(50) PATH '.') FROM DUAL",
      "SELECT XMLTABLE('/a' PASSING BY VALUE HR.value@LINK(1), \"VALUE\"@LINK(1) AS b COLUMNS name VARCHAR2(50) PATH '.') FROM DUAL",
    ])("preserves real routines inside SQL/XML clauses in %s", (target) => {
      expect(expandSqlVariables(`@set LINK = WRONG;\n${target}`, { databaseType }).sql).toBe(target);
    });

    it("preserves remote routines alongside same-name variable references", () => {
      const target = 'SELECT HR.get_value@LINK(@LINK) FROM "Hr"."Employees" /* link */ @LINK WHERE id = @LINK; BEGIN HR.run_job@LINK(@LINK); END;';
      expect(expandSqlVariables(`@set LINK = 7;\n${target}`, { databaseType }).sql).toBe('SELECT HR.get_value@LINK(7) FROM "Hr"."Employees" /* link */ @LINK WHERE id = 7; BEGIN HR.run_job@LINK(7); END;');
    });

    it("expands keyword-led references and leaves unresolved references intact", () => {
      const target = "SELECT CASE WHEN @dm1 THEN @dm1 ELSE @missing END FROM DUAL; BEGIN IF @dm1 THEN NULL; END IF; RETURN @dm1; END;";
      expect(expandSqlVariables(`@set dm1 = 7;\n${target}`, { databaseType }).sql).toBe("SELECT CASE WHEN 7 THEN 7 ELSE @missing END FROM DUAL; BEGIN IF 7 THEN NULL; END IF; RETURN 7; END;");
    });
  });

  describe.each(["oracle", "oceanbase-oracle"] as const)("%s PL/SQL function templates", (databaseType) => {
    it.each(["BEGIN @fn('ok'); END;", "BEGIN LOOP @fn('ok'); EXIT; END LOOP; END;", "BEGIN IF @fn(1)>0 THEN NULL; ELSIF @fn(2)>0 THEN NULL; END IF; END;", "BEGIN WHILE @fn(1)>0 LOOP NULL; END LOOP; END;", "BEGIN RETURN @fn(1); END;"])(
      "expands full and selected function templates in %s",
      (target) => {
        const declarationSql = `@set fn = test_fn;\n${target}`;
        const expected = target.replaceAll("@fn", "test_fn");
        expect(expandSqlVariables(declarationSql, { databaseType }).sql).toBe(expected);
        expect(expandSqlVariables(target, { databaseType, declarationSql }).sql).toBe(expected);
      },
    );

    it.each(["begin", "loop", "elsif", "if", "while", "return"])("preserves qualified and quoted routines named %s with a same-name declaration", (name) => {
      const target = `BEGIN HR.${name}@LINK(1); "${name}"@LINK(1); END; SELECT * FROM ${name}@LINK`;
      expect(expandSqlVariables(`@set LINK = WRONG;\n${target}`, { databaseType }).sql).toBe(target);
    });
  });

  it.each([" ", ""])("expands Dameng THEN%s template calls", (separator) => {
    const sql = `@set value = ABS;\nSELECT CASE WHEN 1=1 THEN${separator}@value(1) ELSE 0 END FROM DUAL`;
    expect(expandSqlVariables(sql, { databaseType: "dameng" }).sql).toBe(`SELECT CASE WHEN 1=1 THEN${separator}ABS(1) ELSE 0 END FROM DUAL`);
  });

  it.each(["", " "])("preserves Dameng THEN table links separated by %j during expansion", (separator) => {
    const sql = `@set LINK = 7;\nSELECT * FROM then${separator}@LINK WHERE id = @LINK`;
    expect(expandSqlVariables(sql, { databaseType: "dameng" }).sql).toBe(`SELECT * FROM then${separator}@LINK WHERE id = 7`);
  });

  it("expands Dameng TOP and LIMIT variables while preserving links", () => {
    const sql = "@set count = 7;\n@set offset = 3;\nSELECT TOP @count * FROM test.table_name @count LIMIT @offset, @count";
    expect(expandSqlVariables(sql, { databaseType: "dameng" }).sql).toBe("SELECT TOP 7 * FROM test.table_name @count LIMIT 3, 7");
  });

  it.each([
    ["@set value = '2026-10-10';\nSELECT DATE @value FROM DUAL", "SELECT DATE '2026-10-10' FROM DUAL"],
    ["@set value = '2026-10-10 12:00:00';\nSELECT TIMESTAMP @value FROM DUAL", "SELECT TIMESTAMP '2026-10-10 12:00:00' FROM DUAL"],
  ])("expands Dameng datetime literal variables in %s", (sql, expected) => {
    expect(expandSqlVariables(sql, { databaseType: "dameng" }).sql).toBe(expected);
  });

  it.each(["postgres", "sqlserver", "mysql"] as const)("keeps legacy at-sign variable expansion for %s", (databaseType) => {
    const sql = "@set dm1 = 7;\nSELECT @dm1 FROM test.table_name@dm1, other_table /* separator */ @dm1";
    expect(expandSqlVariables(sql, { databaseType }).sql).toBe("SELECT 7 FROM test.table_name7, other_table /* separator */ 7");
  });

  it("keeps PostgreSQL ARRAY literals from corrupting later variable references", () => {
    const sql = ["@set selected = 7;", "select ARRAY[']']::varchar[], @selected, ${missing}"].join("\n");
    expect(expandSqlVariables(sql, { databaseType: "postgres" }).sql).toBe("select ARRAY[']']::varchar[], 7, ${missing}");
  });

  it("keeps multiline PostgreSQL ARRAY values in @set declarations", () => {
    const sql = ["@set values = ARRAY[", "  'first',", "  'second'", "];", "select @values;"].join("\n");

    expect(expandSqlVariables(sql, { databaseType: "postgres" }).sql).toBe("select ARRAY[\n  'first',\n  'second'\n];");
  });

  it.each(["sqlserver", "sqlite", "jdbc"] as const)("preserves %s bracket identifiers during variable expansion", (databaseType) => {
    const sql = ["@set selected = 7;", "select [column:@ignored], @selected"].join("\n");
    expect(expandSqlVariables(sql, { databaseType }).sql).toBe("select [column:@ignored], 7");
  });

  it("keeps a value's own quotes and parentheses intact", () => {
    const sql = ["@set filter = (status = 'drafted' and deleted_at is null);", "select * from t where @filter"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from t where (status = 'drafted' and deleted_at is null)");
  });

  it("matches @set case-insensitively", () => {
    const sql = ["@SET a = 7;", "select @a"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 7");
  });

  it("does not treat @settings as an @set declaration", () => {
    const sql = "select @settings from t";
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  it("inlines a multiline value starting on a new line after =", () => {
    const sql = ["@set cond =", "  from users", "  where id = 42;", "select * @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users\n  where id = 42");
  });

  it("terminates a value starting on the same line as = at newline without spanning lines", () => {
    const sql = ["@set cond = from users", "where id = 42;", "select * @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("where id = 42;\nselect * from users");
  });

  it("expands a declaration without semicolon followed by an ordinary statement", () => {
    const sql = ["@set user_id = 42", "select * from users where id = @user_id"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42");
  });

  it("preserves following statement when an unsemicoloned declaration has a line comment", () => {
    const sql = ["@set user_id = 42 -- user id", "select * from users where id = @user_id"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("-- user id\nselect * from users where id = 42");
  });

  it("preserves subsequent statements when an unsemicoloned declaration is followed by multiple statements", () => {
    const sql = ["@set user_id = 42", "select * from users where id = @user_id;", "select 1;"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42;\nselect 1;");
  });

  it("does not swallow selected statement into preceding unsemicoloned declaration", () => {
    const selectedSql = "select * from users where id = @user_id";
    const declarationSql = ["@set user_id = 42", selectedSql].join("\n");
    expect(expandSqlVariables(selectedSql, { declarationSql }).sql).toBe("select * from users where id = 42");
  });

  it("expands an unsemicoloned declaration with CRLF line endings", () => {
    const sql = ["@set user_id = 42", "select * from users where id = @user_id"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42");
  });

  it("expands a semicoloned declaration with CRLF line endings", () => {
    const sql = ["@set user_id = 42;", "select * from users where id = @user_id"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42");
  });

  it("inlines a multiline value with CRLF line endings", () => {
    const sql = ["@set cond =", "  from users", "  where id = 42;", "select * @cond"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users\r\n  where id = 42");
  });

  it("supports sequential declarations with CRLF line endings", () => {
    const sql = ["@set a = 1", "@set b = 2;", "select @a, @b"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, 2");
  });

  it("inlines multiline values with line and block comments", () => {
    const sql = ["@set cond =", "  -- target table", "  from users /* active accounts */", "  where status = 'active';", "select id @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select id -- target table\n  from users /* active accounts */\n  where status = 'active'");
  });

  it("handles semicolons inside comments within a multiline value", () => {
    const sql = ["@set cond =", "  from users -- note: filter by id; active only", "  where id = 42;", "select * @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users -- note: filter by id; active only\n  where id = 42");
  });

  it("supports multiple multiline declarations in sequence", () => {
    const sql = ["@set cond_a =", "  from users", "  where id = 1;", "@set cond_b =", "  from orders", "  where id = 2;", "select * @cond_a union all select * @cond_b"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users\n  where id = 1 union all select * from orders\n  where id = 2");
  });

  it("terminates declaration at newline when followed by another @set declaration without semicolon", () => {
    const sql = ["@set a = 1", "@set b = 2;", "select @a, @b"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, 2");
  });
});

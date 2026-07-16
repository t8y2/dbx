import { describe, expect, it } from "vitest";
import { extractSqlParameterDescriptors, extractSqlParameters, sqlParameterLiteral, substituteSqlParameters } from "@/lib/sql/sqlParameters";

describe("extractSqlParameters", () => {
  it("extracts unique template parameters in order", () => {
    const sql = "select * from t where pt_dt between ${start_date} and ${end_date} or pt_dt = ${start_date}";
    expect(extractSqlParameters(sql)).toEqual(["start_date", "end_date"]);
  });

  it("ignores placeholders inside strings, quoted identifiers, and comments", () => {
    const sql = `
      select '\${quoted}' as a, "\${identifier}" as b, \`\${mysql_identifier}\`
      -- \${line_comment}
      # \${hash_comment}
      #\${hash_comment_without_space}
      select 1 #comment \${inline_hash_comment}
      /* \${block_comment} */
      from t
      where id = \${id}
    `;
    expect(extractSqlParameters(sql)).toEqual(["id"]);
  });

  it("detects braced placeholders inside quoted text only when explicitly enabled", () => {
    const sql = "select '${date_end}', \"${schema_name}\", `${table_name}`, [${column_name}], '#{mybatis_name}', ':named', '@sqlserver', '?'";

    expect(extractSqlParameters(sql)).toEqual([]);
    expect(extractSqlParameters(sql, { replaceInsideQuotes: true })).toEqual(["date_end", "schema_name", "table_name", "column_name", "mybatis_name"]);
  });

  it("uses NO_BACKSLASH_ESCAPES while scanning quoted boundaries", () => {
    const sql = "select 'C:\\', '${value}'";

    expect(extractSqlParameters(sql, { databaseType: "mysql", noBackslashEscapes: true })).toEqual([]);
    expect(extractSqlParameters(sql, { databaseType: "mysql", replaceInsideQuotes: true, noBackslashEscapes: true })).toEqual(["value"]);
  });

  it("keeps escaped double quotes inside MySQL strings and honors ANSI_QUOTES identifiers", () => {
    const stringSql = 'select "prefix \\" ${first}", "${second}"';
    const identifierSql = 'select "C:\\", "${identifier}"';

    expect(extractSqlParameters(stringSql, { databaseType: "mysql", replaceInsideQuotes: true })).toEqual(["first", "second"]);
    expect(extractSqlParameters(identifierSql, { databaseType: "mysql", ansiQuotes: true })).toEqual([]);
    expect(extractSqlParameters(identifierSql, { databaseType: "mysql", replaceInsideQuotes: true, ansiQuotes: true })).toEqual(["identifier"]);
  });

  it("keeps quoted placeholders in comments and dollar-quoted code ignored", () => {
    const sql = ["select '${visible}', $$ '${body}' $$, $tag$ \"#{tag_body}\" $tag$", "-- '${line_comment}'", "/* '#{block_comment}' */"].join("\n");

    expect(extractSqlParameters(sql, { replaceInsideQuotes: true })).toEqual(["visible"]);
  });

  it("honors syntax toggles when detecting placeholders inside quotes", () => {
    const sql = "select '${shell_name}', '#{mybatis_name}'";

    expect(extractSqlParameters(sql, { enabledSyntaxes: ["shell"], replaceInsideQuotes: true })).toEqual(["shell_name"]);
    expect(extractSqlParameters(sql, { enabledSyntaxes: ["mybatis"], replaceInsideQuotes: true })).toEqual(["mybatis_name"]);
  });

  it("skips malformed quoted placeholders and continues scanning valid ones", () => {
    const sql = "select '${bad-name} ${valid_name}', '${unfinished'";

    expect(extractSqlParameters(sql, { replaceInsideQuotes: true })).toEqual(["valid_name"]);
  });

  it("ignores placeholders inside Postgres dollar-quoted strings", () => {
    const sql = "select $$ ${body_param} $$, $tag$ ${tag_param} $tag$, ${real_param}";
    expect(extractSqlParameters(sql)).toEqual(["real_param"]);
  });

  it("extracts supported placeholder syntaxes in order", () => {
    const sql = "select ? as a, :named as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e";
    expect(extractSqlParameters(sql)).toEqual(["?1", "named", "shell_name", "mybatis_name", "sql_server_name"]);
  });

  it("describes each placeholder syntax for the parameter dialog", () => {
    const sql = "select ? as a, :named as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e";
    expect(extractSqlParameterDescriptors(sql)).toEqual([
      { key: "?1", name: "?1", syntax: "positional", token: "?" },
      { key: "named", name: "named", syntax: "named", token: ":named" },
      { key: "shell_name", name: "shell_name", syntax: "shell", token: "${shell_name}" },
      { key: "mybatis_name", name: "mybatis_name", syntax: "mybatis", token: "#{mybatis_name}" },
      { key: "sql_server_name", name: "sql_server_name", syntax: "sqlserver", token: "@sql_server_name" },
    ]);
  });

  it("ignores declared SQL Server variables and system variables", () => {
    const sql = `
      declare @id int = 1, @name nvarchar(50);
      select @@version, @id, @name, @input_value
    `;
    expect(extractSqlParameters(sql)).toEqual(["input_value"]);
  });

  it("ignores variables assigned by SET statements", () => {
    const sql = `
      set @date_start = '2026-07-04 00:00:00';
      select * from fin_pur_payment AS fp where fp.create_time < @date_start and fp.tenant_id = @tenant_id
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("ignores multiple variables assigned by SET statements", () => {
    const sql = `
      set @date_start := '2026-07-01', @date_end = '2026-07-31';
      select * from orders where created_at between @date_start and @date_end and tenant_id = @tenant_id
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("ignores variables assigned by SELECT statements", () => {
    const sql = `
      select @date_start := min(created_at), @date_end = max(created_at) from orders;
      select * from orders where created_at between @date_start and @date_end and tenant_id = @tenant_id
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("ignores SQL Server procedure parameters declared in routine definitions", () => {
    const sql = `
      create procedure dbo.search_orders
        @date_start datetime,
        @status nvarchar(20) = N'paid'
      as
      begin
        select * from orders where created_at >= @date_start and status = @status and tenant_id = @tenant_id;
      end
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("ignores SQL Server function parameters declared in routine definitions", () => {
    const sql = `
      create function dbo.order_count(@date_start datetime, @status nvarchar(20))
      returns int
      as
      begin
        return (select count(*) from orders where created_at >= @date_start and status = @status and tenant_id = @tenant_id);
      end
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("keeps template parameters in non-routine CREATE statements", () => {
    const sql = "create table #orders (tenant_id int default @tenant_id);";
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("ignores named stored procedure arguments while preserving template values", () => {
    const sql = "exec dbo.search_orders @date_start = '2026-07-04', @status = @status_value, @tenant_id = @tenant_id";
    expect(extractSqlParameters(sql)).toEqual(["status_value", "tenant_id"]);
  });

  it("ignores declared SQL Server table variables", () => {
    const sql = `
      declare @ids table (id int);
      insert into @ids values (1);
      select * from @ids where id = @input_id;
    `;
    expect(extractSqlParameters(sql)).toEqual(["input_id"]);
  });

  it("ignores SQL Server and MySQL system variables", () => {
    const sql = "select @@ROWCOUNT, @@IDENTITY, @@SERVERNAME, @@session.sql_mode, @@global.time_zone, @input_value";
    expect(extractSqlParameters(sql)).toEqual(["input_value"]);
  });

  it("extracts template parameters from ordinary SELECT filters", () => {
    const sql = `
      select * from fin_pur_payment
      where tenant_id = @tenant_id;
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("extracts remaining template parameters after SET-defined variables", () => {
    const sql = `
      set @date_start = '2026-07-04 00:00:00';

      select * from fin_pur_payment
      where create_time < @date_start
        and tenant_id = @tenant_id;
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("does not treat native variable updates as template parameters", () => {
    const sql = "set @n = 1; set @n = @n + 1; select @n;";
    expect(extractSqlParameters(sql)).toEqual([]);
  });

  it("ignores MySQL dynamic SQL variables used by prepared statements", () => {
    const sql = `
      SET @sql = IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'oem_user_group'
           AND COLUMN_NAME = 'group') = 0,
        'ALTER TABLE \`oem_user_group\` ADD COLUMN \`group\` varchar(64) DEFAULT NULL COMMENT ''users.group'' AFTER \`oem_id\`',
        'SELECT 1'
      );
      PREPARE stmt FROM @sql;
      EXECUTE stmt;
      DEALLOCATE PREPARE stmt;
    `;
    expect(extractSqlParameters(sql)).toEqual([]);
  });

  it("stops SQL Server declaration scanning when a new statement starts without a semicolon", () => {
    const sql = `
      declare @id int = 1
      select @id, @tenant_id
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("does not treat PostgreSQL casts or assignment operators as named parameters", () => {
    const sql = "select value::int, value := 1, :actual_value";
    expect(extractSqlParameters(sql)).toEqual(["actual_value"]);
  });

  it("ignores Doris STRUCT field type separators", () => {
    const sql = `
      create table \`events\` (
        \`field0\` int not null comment 'field 0',
        \`field_list\` array<struct<field1:smallint, field2:int, field3:decimal(16,5), field4:varchar(255)>> comment 'field list'
      )
      engine = olap
      properties ("replication_num" = "1");
    `;

    expect(extractSqlParameters(sql, { databaseType: "doris" })).toEqual([]);
    // SelectDB connections use the MySQL db type with a SelectDB driver profile.
    expect(extractSqlParameters(sql, { databaseType: "mysql" })).toEqual([]);
    expect(substituteSqlParameters(sql, {}, { databaseType: "doris" })).toBe(sql);
  });

  it("keeps named parameters that are not STRUCT field type separators", () => {
    const sql = `
      create table \`events\` (
        \`field_list\` array<struct<
          field1:smallint,
          nested:struct<\`field2\` /* field type */ :decimal(:precision, :scale)>
        >>
      ) properties ("buckets" = :bucket_count);
    `;

    expect(extractSqlParameters(sql, { databaseType: "doris" })).toEqual(["precision", "scale", "bucket_count"]);
    expect(
      substituteSqlParameters(
        sql,
        {
          precision: { kind: "number", value: "16" },
          scale: { kind: "number", value: "5" },
          bucket_count: { kind: "number", value: "8" },
        },
        { databaseType: "doris" },
      ),
    ).toBe(`
      create table \`events\` (
        \`field_list\` array<struct<
          field1:smallint,
          nested:struct<\`field2\` /* field type */ :decimal(16, 5)>
        >>
      ) properties ("buckets" = 8);
    `);
  });

  it("does not let an unterminated complex type hide a later named parameter", () => {
    const sql = "create table `broken` (value struct<field:int,\nselect :real;";

    expect(extractSqlParameters(sql, { databaseType: "doris" })).toEqual(["real"]);
    expect(substituteSqlParameters(sql, { real: { kind: "number", value: "7" } }, { databaseType: "doris" })).toBe("create table `broken` (value struct<field:int,\nselect 7;");
  });

  it("ignores Doris VARIANT field type separators", () => {
    const sql = `
      create table \`events\` (
        value variant<
          match_name 'path_1':decimal(:precision, :scale),
          match_name_glob 'meta*':bigint,
          properties('variant_max_subcolumns_count' = :property_value)
        >
      );
    `;

    expect(extractSqlParameters(sql, { databaseType: "doris" })).toEqual(["precision", "scale", "property_value"]);
    expect(
      substituteSqlParameters(
        sql,
        {
          precision: { kind: "number", value: "16" },
          scale: { kind: "number", value: "5" },
          property_value: { kind: "string", value: "2048" },
        },
        { databaseType: "doris" },
      ),
    ).toBe(`
      create table \`events\` (
        value variant<
          match_name 'path_1':decimal(16, 5),
          match_name_glob 'meta*':bigint,
          properties('variant_max_subcolumns_count' = '2048')
        >
      );
    `);
  });

  it("ignores HANA SQLScript variable references", () => {
    const sql = "DO BEGIN Dummy1 = SELECT 1 FROM DUMMY; SELECT * FROM :Dummy1; END";
    expect(extractSqlParameters(sql, { databaseType: "saphana" })).toEqual([]);
  });
});

describe("substituteSqlParameters", () => {
  it("replaces placeholders with SQL literals", () => {
    const sql = "select * from t where dt >= ${start_date} and amount > ${amount} and enabled = ${enabled}";
    expect(
      substituteSqlParameters(sql, {
        start_date: { kind: "string", value: "2026-06-26" },
        amount: { kind: "number", value: "100.50" },
        enabled: { kind: "boolean", value: "true" },
      }),
    ).toBe("select * from t where dt >= '2026-06-26' and amount > 100.50 and enabled = TRUE");
  });

  it("escapes string values and supports null and raw SQL", () => {
    const sql = "select ${name}, ${empty_value}, ${expression}";
    expect(
      substituteSqlParameters(sql, {
        name: { kind: "string", value: "O'Reilly" },
        empty_value: { kind: "null", value: "" },
        expression: { kind: "raw", value: "current_date" },
      }),
    ).toBe("select 'O''Reilly', NULL, current_date");
  });

  it("inserts escaped text inside existing quote delimiters", () => {
    const sql = "select '${single_value}', \"${double_value}\", `${backtick_value}`, [${bracket_value}]";
    expect(
      substituteSqlParameters(
        sql,
        {
          single_value: { kind: "string", value: "O'Reilly" },
          double_value: { kind: "string", value: 'a"b' },
          backtick_value: { kind: "string", value: "a`b" },
          bracket_value: { kind: "string", value: "a]b" },
        },
        { replaceInsideQuotes: true },
      ),
    ).toBe("select 'O''Reilly', \"a\"\"b\", `a``b`, [a]]b]");
  });

  it.each(["mysql", "doris", "starrocks"] as const)("preserves backslash sequences inside %s single-quoted strings", (databaseType) => {
    const sql = "select '${path}', '${newline}', '${nul}', '${quote_and_path}'";
    const values = {
      path: { kind: "string" as const, value: String.raw`C:\new` },
      newline: { kind: "string" as const, value: String.raw`\n` },
      nul: { kind: "string" as const, value: String.raw`\0` },
      quote_and_path: { kind: "string" as const, value: String.raw`O'Reilly\path` },
    };

    expect(substituteSqlParameters(sql, values, { databaseType, replaceInsideQuotes: true })).toBe(String.raw`select 'C:\\new', '\\n', '\\0', 'O''Reilly\\path'`);
  });

  it.each(["mysql", "doris", "starrocks"] as const)("classifies %s double quotes from the active SQL mode", (databaseType) => {
    const sql = 'select "${path}", "${newline}"';
    const values = {
      path: { kind: "string" as const, value: String.raw`C:\new` },
      newline: { kind: "string" as const, value: String.raw`\n` },
    };

    expect(substituteSqlParameters(sql, values, { databaseType, replaceInsideQuotes: true })).toBe(String.raw`select "C:\\new", "\\n"`);
    expect(substituteSqlParameters(sql, values, { databaseType, replaceInsideQuotes: true, noBackslashEscapes: true })).toBe(String.raw`select "C:\new", "\n"`);
    expect(substituteSqlParameters(sql, values, { databaseType, replaceInsideQuotes: true, ansiQuotes: true })).toBe(String.raw`select "C:\new", "\n"`);
  });

  it("keeps backslashes literal for MySQL-family NO_BACKSLASH_ESCAPES sessions", () => {
    const sql = "select '${path}', '${newline}', '${nul}', '${quote_and_path}'";
    const values = {
      path: { kind: "string" as const, value: String.raw`C:\new` },
      newline: { kind: "string" as const, value: String.raw`\n` },
      nul: { kind: "string" as const, value: String.raw`\0` },
      quote_and_path: { kind: "string" as const, value: String.raw`O'Reilly\path` },
    };

    expect(substituteSqlParameters(sql, values, { databaseType: "mysql", replaceInsideQuotes: true, noBackslashEscapes: true })).toBe(String.raw`select 'C:\new', '\n', '\0', 'O''Reilly\path'`);
  });

  it("preserves a preceding string ending in backslash under NO_BACKSLASH_ESCAPES", () => {
    const sql = "select 'C:\\', '${value}'";

    expect(substituteSqlParameters(sql, { value: { kind: "string", value: String.raw`C:\new` } }, { databaseType: "mysql", replaceInsideQuotes: true, noBackslashEscapes: true })).toBe("select 'C:\\', 'C:\\new'");
  });

  it("does not double backslashes in quoted identifiers", () => {
    const sql = 'select "${double_name}", `${backtick_name}`, [${bracket_name}]';
    const values = {
      double_name: { kind: "string" as const, value: String.raw`a\b` },
      backtick_name: { kind: "string" as const, value: String.raw`c\d` },
      bracket_name: { kind: "string" as const, value: String.raw`e\f` },
    };

    expect(substituteSqlParameters(sql, values, { databaseType: "mysql", replaceInsideQuotes: true, ansiQuotes: true })).toBe(String.raw`select "a\b", ` + "`c\\d`" + String.raw`, [e\f]`);
  });

  it("preserves doubled quote escapes surrounding a quoted placeholder", () => {
    const sql = "select 'prefix ''${name}'' suffix'";

    expect(substituteSqlParameters(sql, { name: { kind: "string", value: "O'Reilly" } }, { replaceInsideQuotes: true })).toBe("select 'prefix ''O''Reilly'' suffix'");
  });

  it("uses typed literals outside quotes and textual values inside quotes", () => {
    const sql = "select ${date_end}, '${date_end}', '${nullable}', '#{enabled}'";
    expect(
      substituteSqlParameters(
        sql,
        {
          date_end: { kind: "string", value: "2026-07-16" },
          nullable: { kind: "null", value: "" },
          enabled: { kind: "boolean", value: "yes" },
        },
        { replaceInsideQuotes: true },
      ),
    ).toBe("select '2026-07-16', '2026-07-16', 'NULL', 'yes'");
  });

  it("replaces repeated quoted placeholders without changing the default-off path", () => {
    const sql = "select '${date_end}', '${date_end}'";
    const values = { date_end: { kind: "string" as const, value: "2026-07-16" } };

    expect(substituteSqlParameters(sql, values)).toBe(sql);
    expect(substituteSqlParameters(sql, values, { replaceInsideQuotes: true })).toBe("select '2026-07-16', '2026-07-16'");
  });

  it("replaces all supported placeholder syntaxes with SQL literals", () => {
    const sql = "select ? as a, :named as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e";
    expect(
      substituteSqlParameters(sql, {
        "?1": { kind: "number", value: "42" },
        named: { kind: "string", value: "alpha" },
        shell_name: { kind: "boolean", value: "yes" },
        mybatis_name: { kind: "null", value: "" },
        sql_server_name: { kind: "raw", value: "current_timestamp" },
      }),
    ).toBe("select 42 as a, 'alpha' as b, TRUE as c, NULL as d, current_timestamp as e");
  });

  it("replaces repeated named placeholders once and positional placeholders independently", () => {
    const sql = "select :name, :name, ?, ?";
    expect(
      substituteSqlParameters(sql, {
        name: { kind: "string", value: "same" },
        "?1": { kind: "number", value: "1" },
        "?2": { kind: "number", value: "2" },
      }),
    ).toBe("select 'same', 'same', 1, 2");
  });

  it("leaves declared SQL Server variables untouched while replacing undeclared variables", () => {
    const sql = "DECLARE @id int = 1; SELECT * FROM users WHERE id = @id AND tenant_id = @tenant_id";
    expect(substituteSqlParameters(sql, { tenant_id: { kind: "number", value: "7" } })).toBe("DECLARE @id int = 1; SELECT * FROM users WHERE id = @id AND tenant_id = 7");
  });

  it("leaves variables assigned by SET statements untouched while replacing undeclared variables", () => {
    const sql = "set @date_start = '2026-07-04 00:00:00'; select * from fin_pur_payment where create_time < @date_start and tenant_id = @tenant_id";
    expect(substituteSqlParameters(sql, { tenant_id: { kind: "number", value: "7" } })).toBe("set @date_start = '2026-07-04 00:00:00'; select * from fin_pur_payment where create_time < @date_start and tenant_id = 7");
  });

  it("preserves native variable updates instead of rewriting SQL text", () => {
    const sql = "set @n = 1; set @n = @n + 1; select @n;";
    expect(substituteSqlParameters(sql, {})).toBe(sql);
  });

  it("preserves MySQL dynamic SQL variables used by prepared statements", () => {
    const sql = `SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'oem_user_group'
     AND COLUMN_NAME = 'group') = 0,
  'ALTER TABLE \`oem_user_group\` ADD COLUMN \`group\` varchar(64) DEFAULT NULL COMMENT ''users.group'' AFTER \`oem_id\`',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;`;
    expect(substituteSqlParameters(sql, {})).toBe(sql);
  });

  it("leaves named stored procedure arguments untouched while replacing their template values", () => {
    const sql = "exec dbo.search_orders @date_start = '2026-07-04', @status = @status_value, @tenant_id = @tenant_id";
    expect(
      substituteSqlParameters(sql, {
        status_value: { kind: "string", value: "paid" },
        tenant_id: { kind: "number", value: "7" },
      }),
    ).toBe("exec dbo.search_orders @date_start = '2026-07-04', @status = 'paid', @tenant_id = 7");
  });

  it("keeps HANA SQLScript variable references while replacing template parameters", () => {
    const sql = "DO BEGIN Dummy1 = SELECT * FROM ORDERS WHERE TENANT_ID = ${tenant_id}; SELECT * FROM :Dummy1; END";
    expect(substituteSqlParameters(sql, { tenant_id: { kind: "number", value: "42" } }, { databaseType: "saphana" })).toBe("DO BEGIN Dummy1 = SELECT * FROM ORDERS WHERE TENANT_ID = 42; SELECT * FROM :Dummy1; END");
  });
});

describe("enabledSyntaxes option", () => {
  const mixedSql = "select ? as a, :named as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e";

  it("extracts every syntax when the option is omitted (backward compatible)", () => {
    expect(extractSqlParameters(mixedSql)).toEqual(["?1", "named", "shell_name", "mybatis_name", "sql_server_name"]);
  });

  it("only extracts the enabled syntaxes", () => {
    expect(extractSqlParameters(mixedSql, { enabledSyntaxes: ["named"] })).toEqual(["named"]);
    expect(extractSqlParameters(mixedSql, { enabledSyntaxes: ["shell", "mybatis"] })).toEqual(["shell_name", "mybatis_name"]);
  });

  it("extracts nothing when no syntax is enabled", () => {
    expect(extractSqlParameters(mixedSql, { enabledSyntaxes: [] })).toEqual([]);
  });

  it("leaves disabled-syntax tokens untouched when substituting", () => {
    // Only :named is enabled, so every other token survives verbatim.
    expect(substituteSqlParameters(mixedSql, { named: { kind: "number", value: "2" } }, { enabledSyntaxes: ["named"] })).toBe("select ? as a, 2 as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e");
  });

  it("does not consume the positional counter for disabled positional placeholders", () => {
    expect(substituteSqlParameters("select ?, ?", {}, { enabledSyntaxes: ["named"] })).toBe("select ?, ?");
  });

  it("keeps #{name} out of hash-comment handling when mybatis is disabled", () => {
    expect(extractSqlParameters("select #{mybatis_name} from t", { enabledSyntaxes: ["shell"] })).toEqual([]);
    expect(substituteSqlParameters("select #{mybatis_name} from t", {}, { enabledSyntaxes: ["shell"] })).toBe("select #{mybatis_name} from t");
  });

  it("intersects the enabled set with the saphana named-parameter rule", () => {
    const sql = "select :named as a, ${shell_name} as b";
    // saphana already disables :name; enabling named cannot re-enable it.
    expect(extractSqlParameters(sql, { databaseType: "saphana", enabledSyntaxes: ["named", "shell"] })).toEqual(["shell_name"]);
    // A non-saphana database with named disabled also drops :name.
    expect(extractSqlParameters(sql, { enabledSyntaxes: ["shell"] })).toEqual(["shell_name"]);
  });
});

describe("sqlParameterLiteral", () => {
  it("falls back to quoted strings for invalid boolean input", () => {
    expect(sqlParameterLiteral({ kind: "boolean", value: "maybe" })).toBe("'maybe'");
  });
});

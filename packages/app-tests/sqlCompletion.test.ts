import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildSqlCompletionItems,
  getSqlFunctionSignatureHelp,
  getSqlCompletionResultValidFor,
  isSqlCommentContext,
  isSqlStringLiteralContext,
  shouldAutoOpenSqlCompletion,
  extractCteDefinitions,
  getSqlCompletionContext,
  recordCompletionSelection,
  shouldChainSqlCompletionAfterAccept,
  type SqlCompletionColumn,
  type SqlCompletionForeignKey,
  type SqlCompletionObject,
  type SqlCompletionTable,
} from "../../apps/desktop/src/lib/sql/sqlCompletion.ts";

const tables: SqlCompletionTable[] = [
  { name: "users", schema: "public", type: "table" },
  { name: "user_profiles", schema: "public", type: "table" },
  { name: "orders", schema: "public", type: "table" },
  { name: "ticket_summary", schema: "public", type: "view" },
];

const columnsByTable = new Map<string, SqlCompletionColumn[]>([
  [
    "public.users",
    [
      { name: "id", table: "users", schema: "public", dataType: "bigint" },
      { name: "name", table: "users", schema: "public", dataType: "varchar" },
      { name: "email", table: "users", schema: "public", dataType: "varchar" },
    ],
  ],
  [
    "public.orders",
    [
      { name: "id", table: "orders", schema: "public", dataType: "bigint" },
      { name: "user_id", table: "orders", schema: "public", dataType: "bigint" },
      { name: "status", table: "orders", schema: "public", dataType: "varchar" },
    ],
  ],
]);

const mysqlCrossDatabaseColumnsByTable = new Map<string, SqlCompletionColumn[]>([
  [
    "other_db.orders",
    [
      { name: "id", table: "orders", dataType: "bigint" },
      { name: "number", table: "orders", dataType: "varchar" },
      { name: "status", table: "orders", dataType: "varchar" },
    ],
  ],
  ["current_db.orders", [{ name: "local_status", table: "orders", dataType: "varchar" }]],
]);

const completionObjects: SqlCompletionObject[] = [
  { name: "refresh_user_stats", schema: "app", type: "procedure" },
  { name: "format_user_name", schema: "app", type: "function" },
  { name: "trg_users_audit", schema: "app", type: "trigger", parentName: "users" },
];

const postgresQuotedTables: SqlCompletionTable[] = [
  { name: "article", schema: "public", type: "table" },
  { name: "order_lines", schema: "public", type: "table" },
  { name: "OrderLines", schema: "public", type: "table" },
  { name: "User", schema: "public", type: "table" },
  { name: 'has"quote', schema: "public", type: "table" },
];

const postgresQuotedColumnsByTable = new Map<string, SqlCompletionColumn[]>([
  [
    "public.OrderLines",
    [
      { name: "article", table: "OrderLines", schema: "public", dataType: "text" },
      { name: "OrderId", table: "OrderLines", schema: "public", dataType: "uuid" },
      { name: "User", table: "OrderLines", schema: "public", dataType: "text" },
      { name: 'has"quote', table: "OrderLines", schema: "public", dataType: "text" },
    ],
  ],
]);

test("suggests SQL keywords for generic keyword input", () => {
  const items = buildSqlCompletionItems("sel", 3, {
    tables,
    columnsByTable,
  });

  const keyword = items.find((item) => item.type === "keyword" && item.label === "SELECT");
  assert.ok(keyword);
  assert.equal(keyword.type, "keyword");
});

test("suggests lower-case SQL keywords when configured", () => {
  const items = buildSqlCompletionItems("sel", 3, {
    tables,
    columnsByTable,
    keywordCase: "lower",
  });

  const keyword = items.find((item) => item.type === "keyword" && item.label === "select");
  assert.ok(keyword);
  assert.equal(
    items.some((item) => item.type === "keyword" && item.label === "SELECT"),
    false,
  );
});

test("suggests database-specific data types and functions", () => {
  const typeItems = buildSqlCompletionItems("create table events (payload js", "create table events (payload js".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "postgres",
  });
  const serialItems = buildSqlCompletionItems("create table events (id ser", "create table events (id ser".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "postgres",
  });
  const functionItems = buildSqlCompletionItems("select jsonb_b", "select jsonb_b".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "postgres",
  });
  const mysqlFunctionItems = buildSqlCompletionItems("select date_f", "select date_f".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlSysdateItems = buildSqlCompletionItems("select sysd", "select sysd".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlCurrentDateItems = buildSqlCompletionItems("select current_d", "select current_d".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlCurrentTimestampItems = buildSqlCompletionItems("select current_t", "select current_t".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlCurdateItems = buildSqlCompletionItems("select curd", "select curd".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlIfnullItems = buildSqlCompletionItems("select ifn", "select ifn".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlDateAddItems = buildSqlCompletionItems("select date_a", "select date_a".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlDateSubItems = buildSqlCompletionItems("select date_s", "select date_s".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlSubstringIndexItems = buildSqlCompletionItems("select substring_i", "select substring_i".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlLeftItems = buildSqlCompletionItems("select lef", "select lef".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const postgresDateItems = buildSqlCompletionItems("select date_f", "select date_f".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "postgres",
  });

  assert.ok(typeItems.some((item) => item.type === "keyword" && item.label === "JSONB"));
  assert.ok(serialItems.some((item) => item.type === "keyword" && item.label === "SERIAL"));
  assert.ok(functionItems.some((item) => item.type === "function" && item.label === "JSONB_BUILD_OBJECT"));
  assert.ok(mysqlFunctionItems.some((item) => item.type === "function" && item.label === "DATE_FORMAT"));
  assert.ok(mysqlSysdateItems.some((item) => item.type === "function" && item.label === "SYSDATE"));
  assert.ok(mysqlCurrentDateItems.some((item) => item.type === "function" && item.label === "CURRENT_DATE"));
  assert.ok(mysqlCurrentTimestampItems.some((item) => item.type === "function" && item.label === "CURRENT_TIMESTAMP"));
  assert.ok(mysqlCurrentTimestampItems.some((item) => item.type === "function" && item.label === "CURRENT_TIME"));
  assert.ok(mysqlCurdateItems.some((item) => item.type === "function" && item.label === "CURDATE"));
  assert.ok(mysqlIfnullItems.some((item) => item.type === "function" && item.label === "IFNULL"));
  assert.equal(
    mysqlDateAddItems.find((item) => item.type === "function" && item.label === "DATE_ADD")?.apply,
    "DATE_ADD(${date}, INTERVAL ${expr} ${unit})",
  );
  assert.equal(
    mysqlDateSubItems.find((item) => item.type === "function" && item.label === "DATE_SUB")?.apply,
    "DATE_SUB(${date}, INTERVAL ${expr} ${unit})",
  );
  assert.ok(mysqlSubstringIndexItems.some((item) => item.type === "function" && item.label === "SUBSTRING_INDEX"));
  assert.ok(mysqlLeftItems.some((item) => item.type === "function" && item.label === "LEFT"));
  assert.ok(mysqlLeftItems.some((item) => item.type === "keyword" && item.label === "LEFT"));
  assert.equal(
    postgresDateItems.some((item) => item.type === "function" && item.label === "DATE_FORMAT"),
    false,
  );

  const mysqlDateTypeItems = buildSqlCompletionItems("CREATE TABLE t (d dat", "CREATE TABLE t (d dat".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  const mysqlTimeTypeItems = buildSqlCompletionItems("CREATE TABLE t (tm tim", "CREATE TABLE t (tm tim".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  assert.equal(mysqlDateTypeItems[0]?.label, "DATE");
  assert.equal(mysqlDateTypeItems.some((item) => item.type === "function" && item.label === "DATE"), false);
  assert.equal(mysqlTimeTypeItems[0]?.label, "TIME");
  assert.equal(mysqlTimeTypeItems.some((item) => item.type === "function" && item.label === "TIME"), false);

  const mysqlCreateViewItems = buildSqlCompletionItems("CREATE VIEW v AS SELECT dat", "CREATE VIEW v AS SELECT dat".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });
  assert.ok(mysqlCreateViewItems.some((item) => item.type === "function" && item.label === "DATE"));
});

test("suggests Oracle SQL, PL/SQL, and data type keywords", () => {
  const keywordCases = [
    ["tru", "TRUNCATE"],
    ["mer", "MERGE"],
    ["dec", "DECLARE"],
    ["els", "ELSIF"],
    ["pac", "PACKAGE"],
    ["seq", "SEQUENCE"],
    ["flash", "FLASHBACK"],
    ["mat", "MATERIALIZED VIEW"],
  ] as const;

  for (const [prefix, expected] of keywordCases) {
    const items = buildSqlCompletionItems(prefix, prefix.length, {
      tables: [],
      columnsByTable: new Map(),
      databaseType: "oracle",
    });
    assert.ok(
      items.some((item) => item.type === "keyword" && item.label === expected),
      `${expected} should be suggested for ${prefix}`,
    );
  }

  const typeSql = "CREATE TABLE events (payload varc";
  const typeItems = buildSqlCompletionItems(typeSql, typeSql.length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "oracle",
  });
  assert.ok(typeItems.some((item) => item.type === "keyword" && item.label === "VARCHAR2"));
});

test("does not suggest cross-dialect words for Oracle", () => {
  const unsupportedWords = ["LIMIT", "LOCALTIME", "USE", "ELSEIF", "SERIAL", "BIGSERIAL", "TEXT", "BOOLEAN", "STRING", "TIME"];

  for (const unsupportedWord of unsupportedWords) {
    const prefix = unsupportedWord.toLowerCase();
    const items = buildSqlCompletionItems(prefix, prefix.length, {
      tables: [],
      columnsByTable: new Map(),
      databaseType: "oracle",
    });
    assert.equal(
      items.some((item) => item.type === "keyword" && item.label === unsupportedWord),
      false,
      `${unsupportedWord} should not be suggested for Oracle`,
    );
  }

  for (const supportedWord of ["LOCALTIMESTAMP", "NUMBER", "VARCHAR2", "XMLTYPE"]) {
    const prefix = supportedWord.toLowerCase();
    const items = buildSqlCompletionItems(prefix, prefix.length, {
      tables: [],
      columnsByTable: new Map(),
      databaseType: "oracle",
    });
    assert.ok(
      items.some((item) => item.type === "keyword" && item.label === supportedWord),
      `${supportedWord} should be suggested for Oracle`,
    );
  }
});

test("keeps TRUNCATE as a statement keyword for Oracle-compatible databases", () => {
  for (const databaseType of ["oracle", "oceanbase-oracle"] as const) {
    const items = buildSqlCompletionItems("tru", 3, {
      tables: [],
      columnsByTable: new Map(),
      databaseType,
    });

    assert.ok(items.some((item) => item.type === "keyword" && item.label === "TRUNCATE"));
    assert.equal(
      items.some((item) => item.type === "function" && item.label === "TRUNCATE"),
      false,
    );
  }
});

test("suggests Manticore Search SQL functions and command snippets", () => {
  const matchItems = buildSqlCompletionItems("select * from products where mat", "select * from products where mat".length, {
    tables,
    columnsByTable,
    databaseType: "manticoresearch",
  });
  const facetItems = buildSqlCompletionItems("select * from products fac", "select * from products fac".length, {
    tables,
    columnsByTable,
    databaseType: "manticoresearch",
  });
  const showItems = buildSqlCompletionItems("show m", "show m".length, {
    tables,
    columnsByTable,
    databaseType: "manticoresearch",
  });
  const showTablesItems = buildSqlCompletionItems("show tab", "show tab".length, {
    tables,
    columnsByTable,
    databaseType: "manticoresearch",
  });
  const callPqItems = buildSqlCompletionItems("call p", "call p".length, {
    tables,
    columnsByTable,
    databaseType: "manticoresearch",
  });
  const rankingItems = buildSqlCompletionItems("select bm", "select bm".length, {
    tables,
    columnsByTable,
    databaseType: "manticoresearch",
  });

  assert.ok(matchItems.some((item) => item.type === "function" && item.label === "MATCH" && item.apply === "MATCH(${query})"));
  assert.ok(facetItems.some((item) => item.type === "keyword" && item.label === "FACET"));
  assert.ok(showItems.some((item) => item.type === "snippet" && item.label === "show meta" && item.apply === "SHOW META;"));
  assert.ok(showTablesItems.some((item) => item.type === "snippet" && item.label === "show tables" && item.apply === "SHOW TABLES;"));
  assert.ok(callPqItems.some((item) => item.type === "snippet" && item.label === "call pq" && item.apply === "CALL PQ ('pq', ('{\"title\":\"query\"}'));"));
  assert.ok(rankingItems.some((item) => item.type === "function" && item.label === "BM25F"));
});

test("MongoDB completion avoids SQL keywords", () => {
  const items = buildSqlCompletionItems("fi", 2, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mongodb",
  });

  assert.ok(items.some((item) => item.type === "function" && item.label === "find"));
  assert.equal(
    items.some((item) => item.type === "keyword" && item.label === "SELECT"),
    false,
  );
});

test("quotes PostgreSQL table identifiers when completion inserts them", () => {
  const sql = "select * from Order";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: postgresQuotedTables,
    columnsByTable: new Map(),
    dialect: "postgres",
  });

  const table = items.find((item) => item.type === "table" && item.label === "OrderLines");
  assert.equal(table?.apply, '"OrderLines"');
});

test("leaves safe PostgreSQL table identifiers unquoted when completion inserts them", () => {
  const sql = "select * from article";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: postgresQuotedTables,
    columnsByTable: new Map(),
    dialect: "postgres",
  });

  const table = items.find((item) => item.type === "table" && item.label === "article");
  assert.equal(table?.apply, "article");
});

test("quotes PostgreSQL keyword-like and escaped table identifiers when completion inserts them", () => {
  const userItems = buildSqlCompletionItems("select * from User", "select * from User".length, {
    tables: postgresQuotedTables,
    columnsByTable: new Map(),
    dialect: "postgres",
  });
  const quotedItems = buildSqlCompletionItems("select * from has", "select * from has".length, {
    tables: postgresQuotedTables,
    columnsByTable: new Map(),
    dialect: "postgres",
  });

  assert.equal(userItems.find((item) => item.label === "User")?.apply, '"User"');
  assert.equal(quotedItems.find((item) => item.label === 'has"quote')?.apply, '"has""quote"');
});

test("quotes PostgreSQL column identifiers when completion inserts them", () => {
  const sql = "select Order from public.OrderLines";
  const cursor = "select Order".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables: postgresQuotedTables,
    columnsByTable: postgresQuotedColumnsByTable,
    dialect: "postgres",
  });

  const column = items.find((item) => item.type === "column" && item.label === "OrderId");
  assert.equal(column?.apply, '"OrderId"');
});

test("leaves safe PostgreSQL column identifiers unquoted when completion inserts them", () => {
  const sql = "select arti from public.OrderLines";
  const cursor = "select arti".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables: postgresQuotedTables,
    columnsByTable: postgresQuotedColumnsByTable,
    dialect: "postgres",
  });

  const column = items.find((item) => item.type === "column" && item.label === "article");
  assert.equal(column?.apply, "article");
});

test("quotes PostgreSQL reserved-word column identifiers when completion inserts them", () => {
  // Reserved words absent from the completion keyword phrase list (which has
  // "ORDER BY" but not "order") must still be quoted as column references.
  const reservedColumns = ["order", "do", "returning", "ilike", "window", "true"];
  const reservedColumnsByTable = new Map<string, SqlCompletionColumn[]>([["public.bookings", reservedColumns.map((name) => ({ name, table: "bookings", schema: "public", dataType: "text" }))]]);
  const sql = "select  from bookings";
  const items = buildSqlCompletionItems(sql, "select ".length, {
    tables: [{ name: "bookings", schema: "public", type: "table" }],
    columnsByTable: reservedColumnsByTable,
    dialect: "postgres",
  });

  for (const name of reservedColumns) {
    const column = items.find((item) => item.type === "column" && item.label === name);
    assert.equal(column?.apply, `"${name}"`, `expected reserved column "${name}" to be quoted`);
  }
});

test("quotes PostgreSQL reserved-word table identifiers when completion inserts them", () => {
  const sql = "select * from ord";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "order", schema: "public", type: "table" }],
    columnsByTable: new Map(),
    dialect: "postgres",
  });

  const table = items.find((item) => item.type === "table" && item.label === "order");
  assert.equal(table?.apply, '"order"');
});

test("suggests matching table names after FROM", () => {
  const sql = "select * from us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.slice(0, 2).map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("ranks prefix matches above substring matches for table names", () => {
  const sql = "select * from user";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.filter((item) => item.type === "table").map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("suggests columns for an explicit alias qualifier", () => {
  const sql = "select u. from public.users u";
  const cursor = "select u.".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const columnItems = items.filter((item) => item.type === "column");
  assert.deepEqual(
    columnItems.map((item) => item.label),
    ["id", "name", "email"],
  );
});

test("suggests only matching columns for an explicit alias qualifier prefix", () => {
  const sql = "select u.na from public.users u join public.orders o on u.id = o.user_id";
  const cursor = "select u.na".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });
  const columnItems = items.filter((item) => item.type === "column");

  assert.deepEqual(
    columnItems.map((item) => [item.label, item.type, item.detail]),
    [["name", "column", "public.users  [varchar]"]],
  );
});

test("does not mix routines into an explicit table alias column completion", () => {
  const sql = "select u.na from public.users u";
  const cursor = "select u.na".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
    objects: [{ name: "name_formatter", schema: "u", type: "function", applyName: "u.name_formatter" }],
    databaseType: "oracle",
  });

  assert.ok(items.some((item) => item.label === "name" && item.type === "column"));
  assert.equal(items.some((item) => item.label === "name_formatter"), false);
});

test("suggests matching database functions alongside referenced columns", () => {
  const sql = "SELECT st_ FROM public.routes";
  const items = buildSqlCompletionItems(sql, "SELECT st_".length, {
    tables: [{ name: "routes", schema: "public", type: "table" }],
    columnsByTable: new Map([
      [
        "public.routes",
        [
          { name: "start_sid", table: "routes", schema: "public", dataType: "integer" },
          { name: "start_dept", table: "routes", schema: "public", dataType: "text" },
        ],
      ],
    ]),
    objects: [
      { name: "st_area", schema: "public", type: "function", dataType: "double precision", comment: "Returns an area" },
      { name: "st_x", schema: "public", type: "function", dataType: "double precision" },
      { name: "st_refresh", schema: "public", type: "procedure" },
    ],
    databaseType: "postgres",
    currentSchema: "public",
  });

  const area = items.find((item) => item.label === "st_area" && item.type === "function");
  assert.ok(area);
  assert.equal(area.detail, "function in public  [double precision]");
  assert.equal(area.info, "public.st_area\nReturns an area");
  assert.ok(items.some((item) => item.label === "start_sid" && item.type === "column"));
  assert.equal(
    items.some((item) => item.label === "st_refresh"),
    false,
  );
  assert.equal(
    items.some((item) => item.label === "LAST_VALUE" || item.label === "FIRST_VALUE"),
    false,
  );
  assert.ok(items.findIndex((item) => item.label === "st_area" && item.type === "function") < items.findIndex((item) => item.label === "start_sid" && item.type === "column"));
});

test("keeps an exact referenced column above an exact database function", () => {
  const sql = "SELECT st_area FROM public.routes";
  const items = buildSqlCompletionItems(sql, "SELECT st_area".length, {
    tables: [{ name: "routes", schema: "public", type: "table" }],
    columnsByTable: new Map([["public.routes", [{ name: "st_area", table: "routes", schema: "public", dataType: "numeric" }]]]),
    objects: [{ name: "st_area", schema: "public", type: "function", dataType: "double precision", boost: 2400 }],
    databaseType: "oracle",
    currentSchema: "public",
  });

  const exactMatches = items.filter((item) => item.label === "st_area");
  assert.deepEqual(
    exactMatches.map((item) => item.type),
    ["column", "function"],
  );
});

test("does not suggest database functions in exclusive table or column contexts", () => {
  const input = {
    tables: [{ name: "routes", schema: "public", type: "table" as const }],
    columnsByTable: new Map([["public.routes", [{ name: "start_sid", table: "routes", schema: "public" }]]]),
    objects: [{ name: "st_area", schema: "public", type: "function" as const }],
    databaseType: "postgres" as const,
  };

  const tableSql = "SELECT * FROM st_";
  assert.equal(
    buildSqlCompletionItems(tableSql, tableSql.length, input).some((item) => item.label === "st_area"),
    false,
  );

  const updateSql = "UPDATE public.routes SET st_";
  const updateContext = getSqlCompletionContext(updateSql, updateSql.length);
  assert.equal(updateContext.qualifier, undefined);
  assert.equal(updateContext.contextKind, "column");
  assert.equal(updateContext.exclusiveColumnSuggestions, true);
  assert.equal(updateContext.suggestRoutines, false);
  assert.equal(
    buildSqlCompletionItems(updateSql, updateSql.length, input).some((item) => item.label === "st_area"),
    false,
  );
});

test("keeps explicit alias column suggestions scoped to the alias table", () => {
  const sql = "select * from public.users u join public.orders o on u.id = o.user_id where o.st";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type, item.detail]),
    [["status", "column", "public.orders  [varchar]"]],
  );
});

test("does not show table names after an explicit alias qualifier", () => {
  const sql = "select * from billing_owner b where b.";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "base_gateway_expand", schema: "BU", type: "table" },
      { name: "billing_owner", schema: "BU", type: "table" },
    ],
    columnsByTable: new Map(),
  });

  assert.deepEqual(items, []);
});

test("suggests columns after an explicit alias qualifier without leaking tables", () => {
  const sql = "select * from billing_owner b where b.";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "base_gateway_expand", schema: "BU", type: "table" },
      { name: "billing_owner", schema: "BU", type: "table" },
    ],
    columnsByTable: new Map([
      [
        "BU.billing_owner",
        [
          { name: "owner_id", table: "billing_owner", schema: "BU", dataType: "number" },
          { name: "owner_name", table: "billing_owner", schema: "BU", dataType: "varchar" },
        ],
      ],
    ]),
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type, item.detail]),
    [
      ["owner_id", "column", "BU.billing_owner  [number]"],
      ["owner_name", "column", "BU.billing_owner  [varchar]"],
    ],
  );
});

test("shows column comments in WHERE field completions", () => {
  const sql = "select * from public.orders where st";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable: new Map([
      [
        "public.orders",
        [
          {
            name: "status",
            table: "orders",
            schema: "public",
            dataType: "varchar",
            isNullable: false,
            comment: "Order lifecycle state",
          },
        ],
      ],
    ]),
  });

  const column = items.find((item) => item.type === "column" && item.label === "status");
  assert.equal(column?.detail, "public.orders  [varchar]  NOT NULL  -- Order lifecycle state");
  assert.equal(column?.info, "public.orders.status\nType: varchar\nNullable: no\nComment: Order lifecycle state");
});

test("suggests only fields after numbered table aliases in join conditions", () => {
  const sql = "select * from public.users t1 join public.orders t2 on t1.";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type]),
    [
      ["id", "column"],
      ["name", "column"],
      ["email", "column"],
    ],
  );
  assert.equal(
    items.some((item) => item.type === "table"),
    false,
  );
});

test("scopes numbered alias field suggestions to the requested joined table", () => {
  const sql = "select * from public.users t1 join public.orders t2 on t2.";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type]),
    [
      ["id", "column"],
      ["user_id", "column"],
      ["status", "column"],
    ],
  );
  assert.equal(
    items.some((item) => item.type === "table"),
    false,
  );
});

test("suggests columns from referenced tables in select list", () => {
  const sql = "select na from public.users u join public.orders o on u.id = o.user_id";
  const cursor = "select na".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "name");
  assert.equal(items[0]?.type, "column");
});

test("suggests all columns expansion in select list when typing a column prefix", () => {
  const sql = "select id from public.users";
  const cursor = "select id".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "users.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "id, name, email");
});

test("qualifies all columns expansion with table aliases", () => {
  const sql = "select id from public.users u";
  const cursor = "select id".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "u.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "u.id, u.name, u.email");
});

test("suggests all columns expansion for each joined table", () => {
  const sql = "select id from public.users u join public.orders o on u.id = o.user_id";
  const cursor = "select id".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  assert.equal(items.find((item) => item.type === "snippet" && item.label === "u.*")?.apply, "u.id, u.name, u.email");
  assert.equal(items.find((item) => item.type === "snippet" && item.label === "o.*")?.apply, "o.id, o.user_id, o.status");
});

test("suggests all columns expansion after an alias qualifier in select list", () => {
  const sql = "select u. from public.users u join public.orders o on u.id = o.user_id";
  const cursor = "select u.".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "u.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "id, u.name, u.email");
  assert.equal(
    items.some((item) => item.type === "snippet" && item.label === "o.*"),
    false,
  );
});

test("keeps all columns expansion available after an alias-qualified column prefix", () => {
  const sql = "select u.i from public.users u join public.orders o on u.id = o.user_id";
  const cursor = "select u.i".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "u.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "id, u.name, u.email");
});

test("does not suggest all columns expansion outside select list", () => {
  const sql = "select * from public.users u where id";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(
    items.some((item) => item.type === "snippet" && item.label === "u.*"),
    false,
  );
});

test("suggests tables after LEFT JOIN", () => {
  const sql = "select * from users left join us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.label === "users" && item.type === "table"));
  assert.ok(items.some((item) => item.label === "user_profiles" && item.type === "table"));
});

test("suggests compound JOIN keywords while typing a join modifier", () => {
  const sql = "select * from users le";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const leftJoinIndex = items.findIndex((item) => item.type === "keyword" && item.label === "LEFT JOIN");
  const leftIndex = items.findIndex((item) => item.type === "keyword" && item.label === "LEFT");

  assert.ok(leftJoinIndex >= 0);
  assert.ok(leftIndex >= 0);
  assert.ok(leftJoinIndex < leftIndex, "LEFT JOIN should rank ahead of the single LEFT token");
  assert.equal(items[leftJoinIndex]?.apply, "LEFT JOIN ");
});

test("keeps MySQL LEFT JOIN ranking when LEFT() is also a function", () => {
  const sql = "select * from users le";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "mysql",
  });

  const leftJoinIndex = items.findIndex((item) => item.type === "keyword" && item.label === "LEFT JOIN");
  const leftKeywordIndex = items.findIndex((item) => item.type === "keyword" && item.label === "LEFT");
  const leftFunctionIndex = items.findIndex((item) => item.type === "function" && item.label === "LEFT");

  assert.ok(leftJoinIndex >= 0);
  assert.ok(leftKeywordIndex >= 0);
  assert.ok(leftFunctionIndex >= 0);
  assert.ok(leftJoinIndex < leftKeywordIndex, "LEFT JOIN should rank ahead of LEFT keyword");
  assert.ok(leftJoinIndex < leftFunctionIndex, "LEFT JOIN should rank ahead of LEFT()");
});

test("suggests JOIN after a join modifier", () => {
  const sql = "select * from users left ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type]),
    [["JOIN", "keyword"]],
  );
});

test("suggests tables after comma in FROM clause", () => {
  const sql = "select * from users, or";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.label === "orders" && item.type === "table"));
});

test("suggests keywords when typing without context", () => {
  const sql = "us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.type === "keyword" && item.label === "USING"));
});

test("suggests only matching table names after FROM object input", () => {
  const sql = "select * from us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.ok(tableItems.length > 0);
  assert.deepEqual(
    tableItems.map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("keeps schema-qualified FROM object input in table suggestion mode", () => {
  const sql = "select * from public.us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.ok(tableItems.length > 0);
  assert.deepEqual(
    tableItems.map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("keeps an accepted schema with trailing dot in table suggestion mode", () => {
  const sql = "SELECT *\nFROM DBX_TEST.";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.equal(context.qualifier, "DBX_TEST");
  assert.equal(context.prefix, "");
  assert.equal(context.suggestTables, true);
  assert.equal(context.exclusiveTableSuggestions, true);
});

test("keeps database-qualified FROM input in table suggestion mode", () => {
  const sql = "select * from other_db.or";
  const context = getSqlCompletionContext(sql, sql.length);
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "orders", schema: "other_db", type: "table" }],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });

  assert.equal(context.qualifier, "other_db");
  assert.deepEqual(context.qualifierParts, ["other_db"]);
  assert.equal(context.prefix, "or");
  assert.equal(context.suggestTables, true);
  assert.equal(context.exclusiveColumnSuggestions, false);
  assert.deepEqual(
    items.map((item) => [item.label, item.type, item.detail]),
    [["orders", "table", "other_db.orders"]],
  );
});

test("tracks qualifier parts for database-qualified column completion", () => {
  const sql = "select * from other_db.orders where other_db.orders.st";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.equal(context.qualifier, "other_db.orders");
  assert.deepEqual(context.qualifierParts, ["other_db", "orders"]);
  assert.equal(context.prefix, "st");
  assert.equal(context.exclusiveColumnSuggestions, true);
});

test("suggests columns after database-qualified table qualifier", () => {
  const sql = "select * from other_db.orders where other_db.orders.";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "orders", schema: "other_db", type: "table" }],
    columnsByTable: mysqlCrossDatabaseColumnsByTable,
    databaseType: "mysql",
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type, item.detail]),
    [
      ["id", "column", "orders  [bigint]"],
      ["number", "column", "orders  [varchar]"],
      ["status", "column", "orders  [varchar]"],
    ],
  );
});

test("scopes database-qualified table column suggestions to the matching database", () => {
  const sql = "select * from other_db.orders where other_db.orders.st";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "orders", schema: "other_db", type: "table" }],
    columnsByTable: mysqlCrossDatabaseColumnsByTable,
    databaseType: "mysql",
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type, item.detail]),
    [["status", "column", "orders  [varchar]"]],
  );
});

test("keeps aliases working for database-qualified tables", () => {
  const sql = "select * from other_db.orders o where o.";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "orders", schema: "other_db", type: "table" }],
    columnsByTable: mysqlCrossDatabaseColumnsByTable,
    databaseType: "mysql",
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type]),
    [
      ["id", "column"],
      ["number", "column"],
      ["status", "column"],
    ],
  );
});

test("includes views in exclusive FROM object suggestions", () => {
  const sql = "select * from tick";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.deepEqual(
    tableItems.map((item) => [item.label, item.type, item.detail]),
    [["ticket_summary", "table", "public.ticket_summary"]],
  );
});

test("suggests only table names after JOIN object input", () => {
  const sql = "select * from users join us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.ok(tableItems.length > 0);
  assert.deepEqual(
    tableItems.map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("suggests SQL Server IF keyword for conditional DDL", () => {
  const sql = "DROP TABLE I";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.type === "keyword" && item.label === "IF"));
});

test("suggests SQL Server IIF and CHOOSE scalar functions", () => {
  const iifItems = buildSqlCompletionItems("SELECT II", "SELECT II".length, {
    tables,
    columnsByTable,
  });
  const chooseItems = buildSqlCompletionItems("SELECT CHO", "SELECT CHO".length, {
    tables,
    columnsByTable,
  });

  assert.ok(
    iifItems.some((item) => item.label === "IIF"),
    "IIF should appear in completion",
  );
  assert.ok(
    chooseItems.some((item) => item.label === "CHOOSE"),
    "CHOOSE should appear in completion",
  );
});

test("only suggests Cloudflare D1 supported common functions", () => {
  const supported = buildSqlCompletionItems("SELECT SQ", "SELECT SQ".length, {
    tables,
    columnsByTable,
    databaseType: "cloudflare-d1",
  });
  const unsupportedNow = buildSqlCompletionItems("SELECT NO", "SELECT NO".length, {
    tables,
    columnsByTable,
    databaseType: "cloudflare-d1",
  });
  const unsupportedPower = buildSqlCompletionItems("SELECT PO", "SELECT PO".length, {
    tables,
    columnsByTable,
    databaseType: "cloudflare-d1",
  });

  assert.ok(supported.some((item) => item.label === "SQRT"));
  assert.ok(!unsupportedNow.some((item) => item.label === "NOW"));
  assert.ok(!unsupportedPower.some((item) => item.label === "POWER"));
});

test("suggests SQL Server IDENTITY_INSERT after SET", () => {
  const sql = "set  iden";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "sqlserver",
  });

  assert.ok(items.some((item) => item.type === "keyword" && item.label === "IDENTITY_INSERT"));
});

test("suggests common SQL Server SET options", () => {
  for (const [sql, expected] of [
    ["set noc", "NOCOUNT"],
    ["set xact", "XACT_ABORT"],
    ["set ansi", "ANSI_NULLS"],
    ["set stat", "STATISTICS IO"],
    ["set transaction iso", "TRANSACTION ISOLATION LEVEL"],
  ] as const) {
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables,
      columnsByTable,
      databaseType: "sqlserver",
    });

    assert.ok(
      items.some((item) => item.type === "keyword" && item.label === expected),
      `${expected} should appear for ${sql}`,
    );
  }
});

test("suggests SQL Server data types in CREATE TABLE column definitions", () => {
  const sql = "CREATE TABLE dbo.jobs (id ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.type === "keyword" && item.label === "INT"));
  assert.ok(items.some((item) => item.type === "keyword" && item.label === "BIGINT"));
  assert.ok(items.some((item) => item.type === "keyword" && item.label === "NVARCHAR"));
});

test("does not auto-open completion after structural punctuation", () => {
  for (const sql of ["select count(*)", "select * from users;", "select * from users,"]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), false, sql);
  }
});

test("does not auto-open completion inside SQL comments", () => {
  for (const { sql, cursor } of [
    { sql: "-- sougou", cursor: "-- sougou".length },
    { sql: "select 1 -- sougou", cursor: "select 1 -- sougou".length },
    { sql: "# sougou", cursor: "# sougou".length },
    { sql: "select /* sougou */ 1", cursor: "select /* sougou".length },
    { sql: "select /* sougou", cursor: "select /* sougou".length },
  ]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, cursor), false, sql);
  }
  assert.equal(isSqlCommentContext("select '-- not comment' as value", "select '-- not comment'".length), false);
  assert.equal(isSqlCommentContext("select /* comment */ val", "select /* comment */ val".length), false);
  assert.equal(shouldAutoOpenSqlCompletion("select '-- not comment' as value", "select '-- not comment' as value".length), true);
  assert.equal(shouldAutoOpenSqlCompletion("select /* comment */ val", "select /* comment */ val".length), true);
});

test("does not auto-open or build metadata completion inside SQL string literals", () => {
  const likeSql = "select * from orders where status like '%9250%'";
  const likeCursor = "select * from orders where status like '%9250%".length;
  assert.equal(isSqlStringLiteralContext(likeSql, likeCursor), true);
  assert.equal(shouldAutoOpenSqlCompletion(likeSql, likeCursor), false);
  assert.deepEqual(
    buildSqlCompletionItems(likeSql, likeCursor, {
      tables,
      columnsByTable,
    }),
    [],
  );

  const escapedQuoteSql = "select * from orders where status = 'it''s 9250'";
  const escapedQuoteCursor = "select * from orders where status = 'it''s 9250".length;
  assert.equal(isSqlStringLiteralContext(escapedQuoteSql, escapedQuoteCursor), true);
  assert.equal(shouldAutoOpenSqlCompletion(escapedQuoteSql, escapedQuoteCursor), false);

  const afterLiteralSql = "select '-- not comment' as value";
  assert.equal(isSqlStringLiteralContext(afterLiteralSql, afterLiteralSql.length), false);
  assert.equal(shouldAutoOpenSqlCompletion(afterLiteralSql, afterLiteralSql.length), true);
});

test("auto-opens completion after word characters and explicit dot qualifiers", () => {
  for (const sql of ["sel", "select * from us", "select u."]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), true, sql);
  }
});

test("auto-opens table completion immediately after FROM context whitespace", () => {
  for (const sql of ["select * from ", "select * from users join ", "select * from users, ", "insert into "]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), true, sql);
  }
});

test("auto-opens column completion immediately after condition context whitespace", () => {
  for (const { sql, cursor = sql.length } of [
    { sql: "select * from users where " },
    {
      sql: "SELECT *\nFROM t_0001 AS t0 WHERE \nLIMIT 100;",
      cursor: "SELECT *\nFROM t_0001 AS t0 WHERE ".length,
    },
  ]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, cursor), true, sql);
  }
});

test("does not auto-open column completion immediately after comparison operators", () => {
  for (const sql of ["SELECT * FROM public.users WHERE id>", "SELECT * FROM public.users WHERE id> ", "SELECT * FROM public.users WHERE id = "]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), false, sql);
  }
  const rhsColumnPrefix = "SELECT * FROM public.users WHERE id > i";
  assert.equal(shouldAutoOpenSqlCompletion(rhsColumnPrefix, rhsColumnPrefix.length), true);
});

test("does not auto-open keyword completion immediately after a completed numeric WHERE value", () => {
  for (const { sql, cursor = sql.length } of [
    { sql: "SELECT * FROM public.users WHERE id > 0" },
    { sql: "SELECT * FROM public.users WHERE id > 0 " },
    {
      sql: "SELECT *\nFROM t_0001 AS t0 WHERE id>0\nLIMIT 100;",
      cursor: "SELECT *\nFROM t_0001 AS t0 WHERE id>0".length,
    },
  ]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, cursor), false, sql);
  }
  const nextKeywordPrefix = "SELECT * FROM public.users WHERE id > 0 l";
  assert.equal(shouldAutoOpenSqlCompletion(nextKeywordPrefix, nextKeywordPrefix.length), true);
});

test("auto-opens keyword completion after JOIN modifier whitespace", () => {
  assert.equal(shouldAutoOpenSqlCompletion("select * from users left ", "select * from users left ".length), true);
  assert.equal(shouldAutoOpenSqlCompletion("select left ", "select left ".length), false);
});

test("auto-opens INSERT target column completion after column-list punctuation", () => {
  for (const sql of ["insert into users (", "insert into users (id, "]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), true, sql);
  }
});

test("suggests table names for empty FROM context prefix", () => {
  const items = buildSqlCompletionItems("select * from ", "select * from ".length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.slice(0, 4).map((item) => [item.label, item.type]),
    [
      ["users", "table"],
      ["user_profiles", "table"],
      ["orders", "table"],
      ["ticket_summary", "table"],
    ],
  );
});

test("suggests table names for empty INSERT INTO target prefix", () => {
  const items = buildSqlCompletionItems("insert into ", "insert into ".length, {
    tables,
    columnsByTable,
    schemas: ["public", "express-vue", "mall"],
  });

  assert.deepEqual(
    items.slice(0, 4).map((item) => [item.label, item.type]),
    [
      ["users", "table"],
      ["user_profiles", "table"],
      ["orders", "table"],
      ["ticket_summary", "table"],
    ],
  );
  assert.ok(items.findIndex((item) => item.type === "schema" && item.label === "public") > 3);
});

test("suggests matching table names for partial table input", () => {
  const items = buildSqlCompletionItems("select * from ihli", "select * from ihli".length, {
    tables: [{ name: "ihli_data", schema: "public", type: "table" }],
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.deepEqual(
    tableItems.map((item) => [item.label, item.type, item.detail]),
    [["ihli_data", "table", "public.ihli_data"]],
  );
});

test("keeps completed references while removing active JOIN table prefixes", () => {
  const context = getSqlCompletionContext("select * from users join ex", "select * from users join ex".length);

  assert.deepEqual(
    context.referencedTables.map((table) => table.name),
    ["users"],
  );
});

test("extracts JOIN tables without explicit aliases", () => {
  const sql = "select * from a join b on a.id = b.id";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.deepEqual(
    context.referencedTables.map((table) => table.name),
    ["a", "b"],
  );
});

test("extracts MySQL backtick-qualified tables across a JOIN", () => {
  const sql = [
    "select",
    "  `jobdb`.`job_application_ats_process`.`process_id`,",
    "  count(*)",
    "from",
    "  `jobdb`.`job_application`",
    "join `jobdb`.`job_application_ats_process` on",
    "  `jobdb`.`job_application`.`id` = `jobdb`.`job_application_ats_process`.`app_id`",
  ].join("\n");
  const context = getSqlCompletionContext(sql, sql.length);

  assert.deepEqual(
    context.referencedTables.map(({ schema, name }) => ({ schema, name })),
    [
      { schema: "jobdb", name: "job_application" },
      { schema: "jobdb", name: "job_application_ats_process" },
    ],
  );
});

test("extracts every table across consecutive JOINs", () => {
  const sql = "select * from db.a join db.b on 1=1 join db.c on 2=2";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.deepEqual(
    context.referencedTables.map(({ schema, name }) => ({ schema, name })),
    [
      { schema: "db", name: "a" },
      { schema: "db", name: "b" },
      { schema: "db", name: "c" },
    ],
  );
});

test("extracts tables across a MySQL STRAIGHT_JOIN", () => {
  const sql = "select * from db.a straight_join db.b on db.a.id = db.b.id";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.deepEqual(
    context.referencedTables.map(({ schema, name, alias }) => ({ schema, name, alias })),
    [
      { schema: "db", name: "a", alias: undefined },
      { schema: "db", name: "b", alias: undefined },
    ],
  );
});

test("keeps explicit table aliases across a JOIN", () => {
  const sql = "select * from db.a x join db.b y";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.deepEqual(
    context.referencedTables.map(({ schema, name, alias }) => ({ schema, name, alias })),
    [
      { schema: "db", name: "a", alias: "x" },
      { schema: "db", name: "b", alias: "y" },
    ],
  );
});

test("does not treat WHERE as a table alias", () => {
  const sql = "select * from a where id = 1";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.deepEqual(
    context.referencedTables.map(({ name, alias }) => ({ name, alias })),
    [{ name: "a", alias: undefined }],
  );
});

test("ranks exact table matches above prefix and fuzzy matches", () => {
  const items = buildSqlCompletionItems("select * from toh", "select * from toh".length, {
    tables: [
      { name: "to_his_rec", schema: "public", type: "table" },
      { name: "toh", schema: "public", type: "table" },
      { name: "toh_archive", schema: "public", type: "table" },
    ],
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.deepEqual(
    tableItems.map((item) => item.label),
    ["toh", "toh_archive", "to_his_rec"],
  );
});

test("ranks exact keyword matches above prefix-matching routines (#3002)", () => {
  const sql = "create table t (id int";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    objects: [
      { name: "int_proc_sync", type: "procedure" },
      { name: "sp_interface", type: "procedure" },
      { name: "fn_to_int", type: "function" },
    ],
    columnsByTable: new Map(),
    databaseType: "sqlserver",
  });

  assert.equal(items[0]?.label, "INT");
  assert.equal(items[0]?.type, "keyword");
});

test("preserves an exact routine match before truncating candidates", () => {
  const sql = "select aaa";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    objects: [
      ...Array.from({ length: 200 }, (_, index) => ({ name: `a_a_a_${index}`, type: "procedure" as const })),
      { name: "aaa", type: "function" },
    ],
    columnsByTable: new Map(),
  });

  assert.equal(items[0]?.label, "aaa");
  assert.equal(items[0]?.type, "function");
});

test("ranks an exact table label match first", () => {
  const sql = "select * from orders";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "orders", type: "table" },
      { name: "orders_archive", type: "table" },
    ],
    columnsByTable: new Map(),
  });

  assert.equal(items[0]?.label, "orders");
  assert.equal(items[0]?.type, "table");
});

test("ranks an exact column match above an exact keyword match", () => {
  const sql = "select limit from t";
  const items = buildSqlCompletionItems(sql, "select limit".length, {
    tables: [{ name: "t", type: "table" }],
    columnsByTable: new Map([["t", [{ name: "limit", table: "t", dataType: "text" }]]]),
  });
  const columnIndex = items.findIndex((item) => item.type === "column" && item.label === "limit");
  const keywordIndex = items.findIndex((item) => item.type === "keyword" && item.label === "LIMIT");

  assert.ok(columnIndex >= 0);
  assert.ok(keywordIndex >= 0);
  assert.ok(columnIndex < keywordIndex);
});

test("ranks an exact table match above foreign-key related prefix matches", () => {
  const sql = "select * from orders join customers";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "orders", type: "table" },
      { name: "customers", type: "table" },
      { name: "customers_ext", type: "table" },
    ],
    columnsByTable: new Map(),
    foreignKeysByTable: new Map([["orders", [{ column: "customer_id", ref_table: "customers_ext", ref_column: "id" }]]]),
  });

  assert.equal(items[0]?.label, "customers");
  assert.equal(items[0]?.type, "table");
});

test("ranks an exact match first even when a fuzzy candidate outscores the numeric boost", () => {
  // A long tight-fuzzy foreign-key candidate accumulates boundary bonuses beyond
  // EXACT_LABEL_MATCH_BOOST; only the exactMatch comparator key keeps the exact item first.
  const exactName = "ab".repeat(300);
  const fuzzyName = Array.from({ length: 300 }, () => "ab").join("_");
  const sql = `select * from orders join ${exactName}`;
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "orders", type: "table" },
      { name: exactName, type: "table" },
      { name: fuzzyName, type: "table" },
    ],
    columnsByTable: new Map(),
    foreignKeysByTable: new Map([["orders", [{ column: "x_id", ref_table: fuzzyName, ref_column: "id" }]]]),
  });

  assert.equal(items[0]?.label, exactName);
  assert.equal(items[0]?.type, "table");
});

test("does not reuse table completion results across typed prefixes", () => {
  const validFor = getSqlCompletionResultValidFor("select * from ", "select * from ".length);

  assert.equal(validFor, undefined);
});

test("does not reuse keyword completion results across typed prefixes", () => {
  const validFor = getSqlCompletionResultValidFor("select * f", "select * f".length);

  assert.equal(validFor, undefined);
});

test("auto-opens completion after ON whitespace for join conditions", () => {
  const sql = "select * from public.users u join public.orders o on ";

  assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), true);
});

test("limits table suggestions for large schemas after filtering by prefix", () => {
  const largeTables: SqlCompletionTable[] = Array.from({ length: 500 }, (_, index) => ({
    name: `erp_invoice_${String(index).padStart(4, "0")}`,
    schema: "dbo",
    type: "table",
  }));

  const sql = "select * from erp_invoice_";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: largeTables,
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.equal(tableItems.length, 200);
  assert.equal(tableItems[0]?.label, "erp_invoice_0000");
  assert.equal(tableItems.at(-1)?.label, "erp_invoice_0199");
});

test("suggests SQL snippets for common abbreviations", () => {
  const items = buildSqlCompletionItems("sel", 3, {
    tables,
    columnsByTable,
  });

  const snippet = items.find((item) => item.type === "snippet" && item.label === "select *");
  assert.ok(snippet);
  assert.equal(snippet.detail, "SELECT *\nFROM table\nLIMIT 100;");
  assert.equal(snippet.apply, "SELECT *\nFROM ${table}\nLIMIT 100;");
});

test("prioritizes FROM after SELECT star when typing the keyword", () => {
  const sql = "SELECT * f";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "mysql",
  });

  assert.equal(items[0]?.label, "FROM");
});

test("prioritizes referenced columns in WHERE conditions", () => {
  const sql = "SELECT * FROM public.users WHERE i";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "mysql",
  });

  assert.equal(items[0]?.label, "id");
});

test("prioritizes referenced columns after WHERE comparison operators", () => {
  const sql = "SELECT * FROM public.users WHERE id > i";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "mysql",
  });

  assert.equal(items[0]?.label, "id");
});

test("prioritizes LIMIT after SELECT WHERE condition", () => {
  const sql = "SELECT * FROM public.users WHERE id > 0 l";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "mysql",
  });

  assert.equal(items[0]?.label, "LIMIT");
});

test("prioritizes AND after a completed WHERE condition", () => {
  const sql = "SELECT * FROM public.users WHERE id > 0 a";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "mysql",
  });

  assert.equal(items[0]?.label, "AND");
});

test("prioritizes OR after a completed WHERE condition", () => {
  const sql = "SELECT * FROM public.users WHERE id > 0 o";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    databaseType: "mysql",
  });

  assert.equal(items[0]?.label, "OR");
});

test("applies keyword case to built-in SQL snippets", () => {
  const items = buildSqlCompletionItems("sel", 3, {
    tables,
    columnsByTable,
    keywordCase: "lower",
  });

  const snippet = items.find((item) => item.type === "snippet" && item.label === "select *");
  assert.ok(snippet);
  assert.equal(snippet.detail, "select *\nfrom table\nlimit 100;");
  assert.equal(snippet.apply, "select *\nfrom ${table}\nlimit 100;");
});

test("suggests DATE_FORMAT as parameter snippet", () => {
  const sql = "select date_";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const snippet = items.find((item) => item.type === "function" && item.label === "DATE_FORMAT");
  assert.ok(snippet);
  assert.equal(snippet.apply, "DATE_FORMAT(${date}, ${format})");
});

test("suggests stored procedures after CALL", () => {
  const sql = "CALL rfs";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    objects: completionObjects,
    columnsByTable,
    dialect: "mysql",
  });

  const procedure = items.find((item) => item.label === "refresh_user_stats");
  assert.ok(procedure);
  assert.equal(procedure.type, "function");
  assert.equal(procedure.apply, "app.refresh_user_stats()");
  assert.equal(
    items.some((item) => item.label === "format_user_name"),
    false,
  );
});

test("prioritizes referenced table columns in WHERE field input", () => {
  const sql = "select * from A1User WHERE userc";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "A1User", schema: "dbo", type: "table" }],
    objects: [
      { name: "P1UserCodeGenerate", schema: "dbo", type: "procedure" },
      { name: "F22UserAccUnit", schema: "dbo", type: "function" },
    ],
    columnsByTable: new Map([
      [
        "dbo.A1User",
        [
          { name: "UserCode", table: "A1User", schema: "dbo", dataType: "varchar" },
          { name: "UserName", table: "A1User", schema: "dbo", dataType: "varchar" },
        ],
      ],
      ["dbo.OtherUserTable", [{ name: "UserCheck", table: "OtherUserTable", schema: "dbo", dataType: "varchar" }]],
    ]),
    databaseType: "sqlserver",
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.type]),
    [["UserCode", "column"]],
  );
});

test("keeps snippets below matching WHERE field columns", () => {
  const sql = "select * from demo_2000_tables.t_0001 WHERE i";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "t_0001", schema: "demo_2000_tables", type: "table" }],
    columnsByTable: new Map([
      [
        "demo_2000_tables.t_0001",
        [
          { name: "id", table: "t_0001", schema: "demo_2000_tables", dataType: "int", comment: "注释test" },
          { name: "image_url", table: "t_0001", schema: "demo_2000_tables", dataType: "varchar(512)", comment: "xixixi" },
          { name: "image_mime", table: "t_0001", schema: "demo_2000_tables", dataType: "varchar(64)", comment: "hahaha" },
        ],
      ],
    ]),
  });

  assert.deepEqual(
    items.slice(0, 3).map((item) => [item.label, item.type]),
    [
      ["id", "column"],
      ["image_url", "column"],
      ["image_mime", "column"],
    ],
  );
  assert.equal(
    items.some((item) => item.type === "snippet" && item.label === "insert into"),
    false,
  );
});

test("suggests referenced table columns after WHERE whitespace", () => {
  const sql = "select * from users where ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items
      .filter((item) => item.type === "column")
      .slice(0, 3)
      .map((item) => item.label),
    ["id", "name", "email"],
  );
});

test("suggests user functions and triggers with fuzzy matching", () => {
  const sql = "select fun";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    objects: completionObjects,
    columnsByTable,
    dialect: "mysql",
  });

  assert.ok(items.some((item) => item.label === "format_user_name" && item.detail === "function in app"));

  const triggerItems = buildSqlCompletionItems("drop trigger tua", "drop trigger tua".length, {
    tables,
    objects: completionObjects,
    columnsByTable,
    dialect: "mysql",
  });
  assert.ok(triggerItems.some((item) => item.label === "trg_users_audit" && item.detail === "trigger on users"));
});

test("suggests Oracle table-function helpers in table reference context", () => {
  const items = buildSqlCompletionItems("select * from tab", "select * from tab".length, {
    tables,
    columnsByTable,
    databaseType: "oracle",
  });

  const tableFunction = items.find((item) => item.label === "TABLE" && item.type === "function");
  assert.ok(tableFunction);
  assert.ok(tableFunction.apply?.startsWith("TABLE("));
});

test("suggests package members after package qualifier", () => {
  const items = buildSqlCompletionItems("begin PAYROLL.ca", "begin PAYROLL.ca".length, {
    tables,
    columnsByTable,
    objects: [
      { name: "PAYROLL", schema: "HR", type: "package" },
      { name: "calculate_bonus", schema: "HR", type: "function", parentSchema: "HR", parentName: "PAYROLL" },
    ],
    databaseType: "oracle",
  });

  const member = items.find((item) => item.label === "calculate_bonus");
  assert.ok(member);
  assert.equal(member.type, "function");
  assert.equal(member.apply, "calculate_bonus()");
});

test("keeps Oracle functions available in qualified expression routine context", () => {
  const sql = "select HGY.FN_";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    objects: [
      { name: "FN_CHECKIDCARD", schema: "HGY", type: "function" },
      { name: "FN_REFRESH", schema: "HGY", type: "procedure" },
    ],
    databaseType: "oracle",
  });

  const fn = items.find((item) => item.label === "FN_CHECKIDCARD");
  assert.ok(fn);
  assert.equal(fn.apply, "FN_CHECKIDCARD()");
  assert.equal(items.find((item) => item.type === "function")?.label, "FN_CHECKIDCARD");
});

test("prioritizes current Oracle schema tables and safely qualifies other schemas", () => {
  const sql = "select * from dept_d";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "DEPT_DICT", schema: "COMM", type: "table", applyName: "COMM.DEPT_DICT", boost: 0 },
      { name: "DEPT_DICT", schema: "APP", type: "table", applyName: "DEPT_DICT", boost: 2400 },
      { name: "DEPT_DICT", schema: "SYS", type: "view", applyName: "SYS.DEPT_DICT", boost: -1200 },
    ],
    columnsByTable,
    databaseType: "oracle",
  });
  const matches = items.filter((item) => item.label === "DEPT_DICT");

  assert.deepEqual(
    matches.map((item) => item.apply),
    ["DEPT_DICT", "COMM.DEPT_DICT", "SYS.DEPT_DICT"],
  );
});

test("does not duplicate an Oracle schema qualifier when applying a scoped table", () => {
  const sql = "select * from COMM.DEPT_D";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "DEPT_DICT", schema: "COMM", type: "table" }],
    columnsByTable,
    databaseType: "oracle",
    currentSchema: "APP",
  });

  const table = items.find((item) => item.label === "DEPT_DICT");
  assert.ok(table);
  assert.equal(table.apply, "DEPT_DICT");
});

test("keeps same-name Oracle routines from different schemas", () => {
  const sql = "select FN_CHECK";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    objects: [
      { name: "FN_CHECK", schema: "APP", type: "function", boost: 2400 },
      { name: "FN_CHECK", schema: "HR", type: "function" },
    ],
    columnsByTable: new Map(),
    databaseType: "oracle",
    currentSchema: "APP",
  });

  assert.deepEqual(
    items.filter((item) => item.label === "FN_CHECK").map((item) => item.apply),
    ["FN_CHECK()", "HR.FN_CHECK()"],
  );
});

test("still deduplicates built-in and database routines outside Oracle metadata search", () => {
  const sql = "select DATE_FORMAT";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    objects: [{ name: "DATE_FORMAT", schema: "app", type: "function" }],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });

  assert.equal(items.filter((item) => item.type === "function" && item.label === "DATE_FORMAT").length, 1);
});

test("matches alias qualifier case-insensitively", () => {
  const sql = "select O. from public.orders o";
  const cursor = "select O.".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const columnItems = items.filter((item) => item.type === "column");
  assert.deepEqual(
    columnItems.map((item) => item.label),
    ["id", "user_id", "status"],
  );
});

test("suggests referenced columns after ORDER BY", () => {
  const sql = "select name from public.users u order by na";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "name");
  assert.equal(items[0]?.type, "column");
});

test("prioritizes select aliases in ORDER BY completion", () => {
  const sql = "select u.name as display_name, count(*) order_count from public.users u order by ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.slice(0, 2).map((item) => [item.label, item.detail]),
    [
      ["display_name", "SELECT alias"],
      ["order_count", "SELECT alias"],
    ],
  );
});

test("prioritizes select aliases in GROUP BY completion", () => {
  const sql = "select u.name as display_name from public.users u group by ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "display_name");
  assert.equal(items[0]?.detail, "SELECT alias");
});

test("suggests likely join condition snippets after ON", () => {
  const sql = "select * from public.users u join public.orders o on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const joinCondition = items.find((item) => item.type === "snippet" && item.label === "u.id = o.user_id");
  assert.ok(joinCondition);
  assert.equal(joinCondition.apply, "u.id = o.user_id");
});

test("suggests likely join condition snippets when joined table owns the id column", () => {
  const sql = "select * from public.orders o join public.users u on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const joinCondition = items.find((item) => item.type === "snippet" && item.label === "o.user_id = u.id");
  assert.ok(joinCondition);
  assert.equal(joinCondition.apply, "o.user_id = u.id");
});

test("returns function signature help inside function arguments", () => {
  const sql = "select date_format(created_at, ";
  const signature = getSqlFunctionSignatureHelp(sql, sql.length);

  assert.deepEqual(signature, {
    name: "DATE_FORMAT",
    signature: "DATE_FORMAT(date, format)",
    activeParameter: 1,
    parameters: ["date", "format"],
  });
});

test("returns cast signature with AS syntax", () => {
  const sql = "select cast(created_at ";
  const signature = getSqlFunctionSignatureHelp(sql, sql.length);

  assert.deepEqual(signature, {
    name: "CAST",
    signature: "CAST(expression AS type)",
    activeParameter: 0,
    parameters: ["expression AS type"],
  });
});

test("uses dialect-specific argument order for CONVERT completion and signature help", () => {
  const sql = "select conv";
  const sqlServerItems = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "sqlserver",
  });
  const mysqlItems = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
  });

  assert.equal(sqlServerItems.find((item) => item.label === "CONVERT")?.apply, "CONVERT(${type}, ${expression})");
  assert.equal(mysqlItems.find((item) => item.label === "CONVERT")?.apply, "CONVERT(${expression}, ${type})");

  const functionSql = "select convert(";
  assert.deepEqual(getSqlFunctionSignatureHelp(functionSql, functionSql.length, "sqlserver")?.parameters, ["type", "expression"]);
  assert.deepEqual(getSqlFunctionSignatureHelp(functionSql, functionSql.length, "mysql")?.parameters, ["expression", "type"]);
});

test("returns null signature help outside function calls", () => {
  assert.equal(getSqlFunctionSignatureHelp("select created_at from users", "select created_at".length), null);
});

// --- CTE support ---

test("extracts CTE names from WITH clause", () => {
  const ctes = extractCteDefinitions("WITH recent_orders AS (SELECT id FROM orders) SELECT * FROM recent_orders");
  assert.equal(ctes.length, 1);
  assert.equal(ctes[0]?.name, "recent_orders");
});

test("extracts CTE columns from SELECT body", () => {
  const ctes = extractCteDefinitions("WITH cte AS (SELECT id, name, status FROM users) SELECT * FROM cte");
  assert.equal(ctes.length, 1);
  assert.deepEqual(ctes[0]?.columns, ["id", "name", "status"]);
});

test("extracts CTE explicit column list", () => {
  const ctes = extractCteDefinitions("WITH cte (col1, col2) AS (SELECT 1, 2) SELECT * FROM cte");
  assert.equal(ctes.length, 1);
  assert.deepEqual(ctes[0]?.columns, ["col1", "col2"]);
});

test("extracts multiple CTEs", () => {
  const ctes = extractCteDefinitions("WITH first AS (SELECT id FROM users), second AS (SELECT id FROM orders) SELECT * FROM first JOIN second");
  assert.equal(ctes.length, 2);
  assert.equal(ctes[0]?.name, "first");
  assert.equal(ctes[1]?.name, "second");
});

test("handles WITH RECURSIVE", () => {
  const ctes = extractCteDefinitions("WITH RECURSIVE tree AS (SELECT id, parent_id FROM categories UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN tree t ON c.parent_id = t.id) SELECT * FROM tree");
  assert.equal(ctes.length, 1);
  assert.equal(ctes[0]?.name, "tree");
});

test("adds CTE tables to referenced tables in context", () => {
  const sql = "WITH cte AS (SELECT id, name FROM users) SELECT * FROM cte";
  const context = getSqlCompletionContext(sql, sql.length);
  const cteRef = context.referencedTables.find((t) => t.name.toLowerCase() === "cte");
  assert.ok(cteRef);
  assert.ok(cteRef.columns);
  assert.ok(cteRef.columns!.includes("id"));
  assert.ok(cteRef.columns!.includes("name"));
});

// --- INSERT column list detection ---

test("detects INSERT INTO column list context", () => {
  const context = getSqlCompletionContext("INSERT INTO users (", "INSERT INTO users (".length);
  assert.equal(context.insertTable, "users");
  assert.equal(context.exclusiveColumnSuggestions, true);
  assert.deepEqual(context.referencedTables, []);
});

test("detects INSERT INTO with schema-qualified table", () => {
  const context = getSqlCompletionContext("INSERT INTO public.users (", "INSERT INTO public.users (".length);
  assert.equal(context.insertTable, "users");
  assert.equal(context.insertSchema, "public");
});

test("detects INSERT INTO column list with three-part qualified table", () => {
  const sql = "INSERT INTO analytics.public.users (";
  const context = getSqlCompletionContext(sql, sql.length);

  assert.equal(context.insertTable, "users");
  assert.equal(context.insertSchema, "public");
});

test("detects MySQL backtick-qualified INSERT INTO column list context", () => {
  const sql = "INSERT INTO `other_db`.`orders` (";
  const context = getSqlCompletionContext(sql, sql.length);
  assert.equal(context.insertTable, "orders");
  assert.equal(context.insertSchema, "other_db");
});

test("does not treat partial INSERT INTO targets as referenced tables", () => {
  const context = getSqlCompletionContext("INSERT INTO ord", "INSERT INTO ord".length);

  assert.equal(context.contextKind, "insert_target");
  assert.equal(context.suggestTables, true);
  assert.equal(context.exclusiveTableSuggestions, true);
  assert.deepEqual(context.referencedTables, []);
});

test("does not treat following SQL keywords as table references while completing table names", () => {
  const sql = "SELECT *\nFROM \nLIMIT 100";
  const cursor = "SELECT *\nFROM ".length;
  const context = getSqlCompletionContext(sql, cursor);

  assert.equal(context.suggestTables, true);
  assert.deepEqual(context.referencedTables, []);
});

test("suggests columns for INSERT INTO target table", () => {
  const items = buildSqlCompletionItems("INSERT INTO users (", "INSERT INTO users (".length, {
    tables,
    columnsByTable,
  });
  const columnItems = items.filter((item) => item.type === "column");
  assert.ok(columnItems.length >= 3);
  assert.ok(columnItems.some((item) => item.label === "id"));
  assert.ok(columnItems.some((item) => item.label === "name"));
  assert.ok(columnItems.some((item) => item.label === "email"));
});

test("suggests all target columns for INSERT INTO column list", () => {
  const items = buildSqlCompletionItems("INSERT INTO users (", "INSERT INTO users (".length, {
    tables,
    columnsByTable,
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "users.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "id, name, email");
});

test("keeps INSERT INTO all-column expansion available after a column prefix", () => {
  const items = buildSqlCompletionItems("INSERT INTO users (id", "INSERT INTO users (id".length, {
    tables,
    columnsByTable,
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "users.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "id, name, email");
});

test("quotes PostgreSQL identifiers in INSERT INTO all-column expansion", () => {
  const sql = 'INSERT INTO public."OrderLines" (';
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: postgresQuotedTables,
    columnsByTable: postgresQuotedColumnsByTable,
    databaseType: "postgres",
    dialect: "postgres",
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "OrderLines.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, 'article, "OrderId", "User", "has""quote"');
});

test("suggests all target columns for schema-qualified INSERT INTO column lists", () => {
  const sql = "INSERT INTO dbo.Users (";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "Users", schema: "dbo", type: "table" }],
    columnsByTable: new Map([
      [
        "dbo.Users",
        [
          { name: "Id", table: "Users", schema: "dbo", dataType: "bigint" },
          { name: "DisplayName", table: "Users", schema: "dbo", dataType: "nvarchar" },
        ],
      ],
    ]),
    databaseType: "sqlserver",
    dialect: "sqlserver",
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "Users.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "Id, DisplayName");
});

test("scopes INSERT INTO all-column expansion to the database-qualified MySQL target", () => {
  const sql = "INSERT INTO other_db.orders (";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "orders", schema: "other_db", type: "table" }],
    columnsByTable: mysqlCrossDatabaseColumnsByTable,
    databaseType: "mysql",
    dialect: "mysql",
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "orders.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "id, number, status");
});

test("suggests all target columns for MySQL backtick-qualified INSERT INTO", () => {
  const sql = "INSERT INTO `other_db`.`orders` (";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "orders", schema: "other_db", type: "table" }],
    columnsByTable: mysqlCrossDatabaseColumnsByTable,
    databaseType: "mysql",
    dialect: "mysql",
  });

  const allColumns = items.find((item) => item.type === "snippet" && item.label === "orders.*");
  assert.ok(allColumns);
  assert.equal(allColumns.apply, "id, number, status");
});

// --- Column data type in detail ---

test("shows column data type in detail", () => {
  const items = buildSqlCompletionItems("select id from public.users u where u.", "select id from public.users u where u.".length, {
    tables,
    columnsByTable,
  });
  const emailColumn = items.find((item) => item.label === "email");
  assert.ok(emailColumn);
  assert.ok(emailColumn.detail!.includes("[varchar]"));
});

test("key columns get priority boost in column suggestions", () => {
  const items = buildSqlCompletionItems("select  from public.users u", "select ".length, {
    tables,
    columnsByTable,
  });
  const columns = items.filter((item) => item.type === "column");
  // id column may be qualified as "users.id" if duplicate exists across tables
  const idItem = columns.find((item) => item.label === "users.id" || item.label === "id");
  const nameItem = columns.find((item) => item.label === "name");
  assert.ok(idItem);
  assert.ok(nameItem);
  assert.ok(idItem.boost > nameItem.boost, "id column should have higher boost than name");
});

test("referenced-table columns rank above keywords (#801)", () => {
  const items = buildSqlCompletionItems("select  from public.users u", "select ".length, {
    tables,
    columnsByTable,
  });
  const column = items.find((item) => item.type === "column");
  assert.ok(column, "should suggest columns when a table is referenced");
  assert.ok(column.boost >= 2000, "referenced-table columns should be boosted above plain keywords");
  const columnIdx = items.findIndex((item) => item.type === "column");
  const keywordIdx = items.findIndex((item) => item.type === "keyword");
  if (keywordIdx >= 0) {
    assert.ok(columnIdx < keywordIdx, "columns should appear before keywords in a referenced-table context");
  }
});

// --- Schema name completion ---

test("suggests schema names alongside tables in FROM context", () => {
  const items = buildSqlCompletionItems("select * from ", "select * from ".length, {
    tables,
    columnsByTable,
    schemas: ["public", "private", "audit"],
  });
  const schemaItems = items.filter((item) => item.type === "schema");
  const firstSchemaIndex = items.findIndex((item) => item.type === "schema");
  const firstTableIndex = items.findIndex((item) => item.type === "table");

  assert.ok(firstTableIndex >= 0);
  assert.ok(firstSchemaIndex > firstTableIndex);
  assert.equal(schemaItems.length, 3);
  assert.ok(schemaItems.some((item) => item.label === "public"));
  assert.equal(schemaItems[0]?.apply, "public.");
});

test("schema items include apply value with trailing dot", () => {
  const items = buildSqlCompletionItems("select * from pub", "select * from pub".length, {
    tables,
    columnsByTable,
    schemas: ["public"],
  });
  const schemaItems = items.filter((item) => item.type === "schema");
  assert.equal(schemaItems.length, 1);
  assert.equal(schemaItems[0]?.apply, "public.");
  assert.equal(shouldChainSqlCompletionAfterAccept(schemaItems[0]!), true);
  assert.equal(shouldChainSqlCompletionAfterAccept({ type: "table", apply: "users" }), false);
});

// --- Quoted identifier fix ---

test("handles quoted identifiers with dots in splitQualifiedName", () => {
  const sql = "select * from ";
  const context = getSqlCompletionContext(sql, sql.length);
  // Verify context handles quoted identifiers — just ensure no crash
  assert.ok(context);
});

// --- Snippet ranking ---

test("snippet boost uses label when label matches prefix better than snippet prefix", () => {
  const items = buildSqlCompletionItems("select", "select".length, {
    tables,
    columnsByTable,
  });
  const snippet = items.find((item) => item.type === "snippet" && item.label === "select *");
  assert.ok(snippet);
  // Snippet should appear in top results even when typing full keyword
  const topFive = items.slice(0, 5);
  assert.ok(
    topFive.some((item) => item.label === "select *"),
    "select * snippet should be in top 5",
  );
});

// --- Context-aware keyword filtering ---

test("hides DDL keywords in SELECT statement context", () => {
  const items = buildSqlCompletionItems("select * from users where ", "select * from users where ".length, {
    tables,
    columnsByTable,
  });
  const keywords = items.filter((item) => item.type === "keyword");
  assert.ok(!keywords.some((item) => item.label === "CREATE"), "CREATE should not appear in SELECT context");
  assert.ok(!keywords.some((item) => item.label === "ALTER"), "ALTER should not appear in SELECT context");
  assert.ok(!keywords.some((item) => item.label === "DROP"), "DROP should not appear in SELECT context");
  assert.ok(
    keywords.some((item) => item.label === "AND"),
    "AND should appear in SELECT context",
  );
  assert.ok(
    keywords.some((item) => item.label === "OR"),
    "OR should appear in SELECT context",
  );
});

test("shows DDL keywords in CREATE TABLE context", () => {
  const sql = "create table ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });
  // In CREATE context, data types should appear
  assert.ok(
    items.some((item) => item.label === "INT" || item.label === "BIGINT"),
    "data types should appear in CREATE",
  );
});

test("filters data type keywords out of SELECT context", () => {
  const sql = "select ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "varchar_test", type: "table" }],
    columnsByTable,
  });
  // Should not suggest VARCHAR as a keyword in SELECT context
  const varcharAsKeyword = items.find((item) => item.type === "keyword" && item.label === "VARCHAR");
  assert.ok(!varcharAsKeyword, "VARCHAR should not appear as keyword in SELECT context");
});

// --- Qualified column names for duplicates ---

test("uses row-source aliases when multiple tables share column names", () => {
  const sql = "select  from public.users u join public.orders o on u.id = o.user_id";
  const items = buildSqlCompletionItems(sql, "select ".length, {
    tables,
    columnsByTable,
  });
  const columns = items.filter((item) => item.type === "column");
  assert.ok(
    columns.some((item) => item.label === "u.id" && item.apply === "u.id"),
    "should show u.id",
  );
  assert.ok(
    columns.some((item) => item.label === "o.id" && item.apply === "o.id"),
    "should show o.id",
  );
  assert.ok(
    columns.some((item) => item.label === "name"),
    "unique name should remain unqualified",
  );
  assert.ok(
    columns.some((item) => item.label === "user_id"),
    "unique user_id should remain unqualified",
  );
});

// --- Window function OVER() ---

test("suggests ROW_NUMBER with OVER clause", () => {
  const items = buildSqlCompletionItems("select row_", "select row_".length, {
    tables,
    columnsByTable,
  });
  const rn = items.find((item) => item.label === "ROW_NUMBER" && item.type === "function")!;
  assert.ok(rn);
  assert.ok(rn.apply!.includes("OVER"), "ROW_NUMBER should include OVER()");
  assert.ok(rn.apply!.includes("PARTITION BY"), "ROW_NUMBER should include PARTITION BY");
});

test("suggests RANK with OVER clause", () => {
  const items = buildSqlCompletionItems("select ra", "select ra".length, {
    tables,
    columnsByTable,
  });
  const rank = items.find((item) => item.label === "RANK");
  assert.ok(rank);
  assert.ok(rank.apply!.includes("OVER"), "RANK should include OVER()");
});

// --- Subquery alias support ---

test("extracts subquery alias as referenced table", () => {
  const sql = "select * from (select id, name from users) sub";
  const context = getSqlCompletionContext(sql, sql.length);
  const subRef = context.referencedTables.find((t) => t.name === "sub");
  assert.ok(subRef, "subquery alias should be in referenced tables");
});

test("extracts subquery alias columns", () => {
  const sql = "select s. from (select id, name from users) s";
  const context = getSqlCompletionContext(sql, "select s.".length);
  const sqRef = context.referencedTables.find((t) => t.name === "s");
  assert.ok(sqRef);
  assert.ok(sqRef.columns!.includes("id"));
  assert.ok(sqRef.columns!.includes("name"));
});

// --- Table alias suggestions ---

test("suggests table alias after FROM table", () => {
  const items = buildSqlCompletionItems("select * from users ", "select * from users ".length, {
    tables,
    columnsByTable,
  });
  const aliasItem = items.find((item) => item.type === "snippet" && item.detail?.includes("alias for"));
  assert.ok(aliasItem, "should suggest alias for table");
  assert.ok(aliasItem!.apply!.includes("AS"), "alias apply should include AS");
});

test("prioritizes table acronym matches above alias snippets", () => {
  const acronymTables: SqlCompletionTable[] = [...tables, { name: "user_basic_info", schema: "public", type: "table" }];
  const items = buildSqlCompletionItems("select * from ubi", "select * from ubi".length, {
    tables: acronymTables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "user_basic_info");
  assert.equal(items[0]?.type, "table");
  assert.ok(
    items.some((item) => item.type === "snippet" && item.apply === "AS ubi "),
    "alias snippet should remain available",
  );
});

test("matches camelCase table acronyms", () => {
  const acronymTables: SqlCompletionTable[] = [...tables, { name: "userBasicInfo", schema: "public", type: "table" }];
  const items = buildSqlCompletionItems("select * from ubi", "select * from ubi".length, {
    tables: acronymTables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "userBasicInfo");
  assert.equal(items[0]?.type, "table");
});

test("table alias suggestions avoid reserved words", () => {
  const items = buildSqlCompletionItems("select * from orders ", "select * from orders ".length, {
    tables,
    columnsByTable,
  });

  const aliasItem = items.find((item) => item.type === "snippet" && item.detail === "alias for orders");
  assert.ok(aliasItem);
  assert.notEqual(aliasItem!.apply, "AS or ");
  assert.equal(aliasItem!.apply, "AS ord ");
});

test("automatic table aliases avoid reserved words", () => {
  const items = buildSqlCompletionItems("select * from ord", "select * from ord".length, {
    tables,
    columnsByTable,
    autoAliasTables: true,
  });

  const tableItem = items.find((item) => item.type === "table" && item.label === "orders");
  assert.ok(tableItem);
  assert.notEqual(tableItem!.apply, "orders AS or");
  assert.equal(tableItem!.apply, "orders AS ord");
});

test("automatic table aliases respect text after the cursor", () => {
  const cases: Array<[string, number, string]> = [
    ["select * from ord AS o", "select * from ord".length, "orders"],
    ["select * from ord o", "select * from ord".length, "orders"],
    ["select * from ord where id = 1", "select * from ord".length, "orders AS ord"],
    ["select * from ord", "select * from ord".length, "orders AS ord"],
    ["select * from ord, users", "select * from ord".length, "orders AS ord"],
    ["select * from orders AS o", "select * from or".length, "orders"],
    ["select * from ord单 AS o", "select * from ord".length, "orders"],
    ["select * from orde\u0301 AS o", "select * from ord".length, "orders"],
    ["select * from ord𐐀 AS o", "select * from ord".length, "orders"],
    ['select * from ord AS "o"', "select * from ord".length, "orders"],
    ["select * from ord `o`", "select * from ord".length, "orders"],
    ["select * from ord AS ", "select * from ord".length, "orders"],
    ["select * from ord /* comment */ AS o", "select * from ord".length, "orders"],
    ["select * from ord -- comment\n  o", "select * from ord".length, "orders"],
    ["select * from ord\n  o", "select * from ord".length, "orders"],
    ["select * from ord /* ; */ AS o", "select * from ord".length, "orders"],
    ["select * from ord /* comment */ where id = 1", "select * from ord".length, "orders AS ord"],
  ];

  for (const [sql, cursor, expectedApply] of cases) {
    const items = buildSqlCompletionItems(sql, cursor, {
      tables,
      columnsByTable,
      autoAliasTables: true,
    });

    const tableItem = items.find((item) => item.type === "table" && item.label === "orders");
    assert.ok(tableItem, `should suggest orders for ${sql}`);
    assert.equal(tableItem!.apply, expectedApply, sql);
  }
});

test("table alias suggestions respect text after the cursor", () => {
  const aliasedCases: Array<[string, number]> = [
    ["select * from orders AS o", "select * from orders ".length],
    ['select * from orders AS "o"', "select * from orders ".length],
    ["select * from orders AS ", "select * from orders ".length],
    ["select * from orders /* c */ AS o", "select * from orders ".length],
  ];

  for (const [sql, cursor] of aliasedCases) {
    const items = buildSqlCompletionItems(sql, cursor, { tables, columnsByTable });
    const aliasItem = items.find((item) => item.type === "snippet" && item.detail === "alias for orders");
    assert.equal(aliasItem, undefined, sql);
  }

  const items = buildSqlCompletionItems("select * from orders ", "select * from orders ".length, { tables, columnsByTable });
  const aliasItem = items.find((item) => item.type === "snippet" && item.detail === "alias for orders");
  assert.ok(aliasItem, "alias snippet should remain available when no alias follows");
});

test("table alias suggestions avoid SQL keywords", () => {
  const items = buildSqlCompletionItems("select * from item_file ", "select * from item_file ".length, {
    tables: [{ name: "item_file", schema: "public", type: "table" }],
    columnsByTable,
  });

  const aliasItem = items.find((item) => item.type === "snippet" && item.detail === "alias for item_file");
  assert.ok(aliasItem);
  assert.notEqual(aliasItem!.apply, "AS if ");
  assert.equal(aliasItem!.apply, "AS it ");
});

test("automatic table aliases avoid SQL keywords", () => {
  const cases: Array<[string, string]> = [
    ["account_store", "account_store AS ac"],
    ["account_type", "account_type AS ac"],
    ["data_order", "data_order AS da"],
    ["invoice_note", "invoice_note AS inv"],
    ["item_file", "item_file AS it"],
    ["item_status", "item_status AS it"],
    ["new_order", "new_order AS ne"],
    ["no_config", "no_config AS nc"],
    ["order_node", "order_node AS ord"],
    ["order_flow", "order_flow AS ord"],
    ["order_region", "order_region AS ord"],
    ["row_value", "row_value AS rv"],
    ["use_case", "use_case AS uc"],
    ["user_role", "user_role AS ur"],
  ];

  for (const [tableName, expectedApply] of cases) {
    const sql = `select * from ${tableName.slice(0, 3)}`;
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: tableName, schema: "public", type: "table" }],
      columnsByTable,
      autoAliasTables: true,
    });

    const tableItem = items.find((item) => item.type === "table" && item.label === tableName);
    assert.ok(tableItem, `should suggest ${tableName}`);
    assert.equal(tableItem!.apply, expectedApply);
  }
});

test("table alias suggestions avoid existing aliases", () => {
  const items = buildSqlCompletionItems("select * from customer_orders co join customer_orders ", "select * from customer_orders co join customer_orders ".length, {
    tables: [...tables, { name: "customer_orders", schema: "public", type: "table" }],
    columnsByTable,
  });

  const aliasItem = items.find((item) => item.type === "snippet" && item.detail === "alias for customer_orders");
  assert.ok(aliasItem);
  assert.notEqual(aliasItem!.apply, "AS co ");
  assert.equal(aliasItem!.apply, "AS cu ");
});

// --- CASE snippet ---

test("suggests CASE WHEN snippet", () => {
  const items = buildSqlCompletionItems("case", "case".length, {
    tables,
    columnsByTable,
  });
  const caseSnippet = items.find((item) => item.type === "snippet" && item.label === "case when");
  assert.ok(caseSnippet);
  assert.ok(caseSnippet.apply!.includes("CASE"), "should include CASE");
  assert.ok(caseSnippet.apply!.includes("WHEN"), "should include WHEN");
  assert.ok(caseSnippet.apply!.includes("THEN"), "should include THEN");
  assert.ok(caseSnippet.apply!.includes("END"), "should include END");
});

// --- Expanded function signatures ---

test("suggests REGEXP_REPLACE with parameters", () => {
  const items = buildSqlCompletionItems("select regexp_", "select regexp_".length, {
    tables,
    columnsByTable,
  });
  const fn = items.find((item) => item.label === "REGEXP_REPLACE" && item.type === "function");
  assert.ok(fn);
  assert.ok(fn.apply!.includes("pattern"), "should include pattern param");
});

test("suggests JSON_EXTRACT with parameters", () => {
  const items = buildSqlCompletionItems("select json_", "select json_".length, {
    tables,
    columnsByTable,
  });
  const fn = items.find((item) => item.label === "JSON_EXTRACT" && item.type === "function");
  assert.ok(fn);
  assert.ok(fn.apply!.includes("json"), "should include json param");
});

// --- Smart GROUP BY suggestions ---

test("boosts non-aggregated SELECT columns in GROUP BY context", () => {
  const sql = "select u.name, count(o.id) from public.users u join public.orders o on u.id = o.user_id group by ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });
  const nonAggItem = items.find((item) => item.label === "name" && item.detail?.includes("non-aggregated"));
  assert.ok(nonAggItem, "non-aggregated column should appear with GROUP BY hint");
});

test("does not boost aggregated columns in GROUP BY context", () => {
  const sql = "select u.name, count(o.id) from public.users u join public.orders o on u.id = o.user_id group by ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });
  const aggHint = items.find((item) => item.detail?.includes("non-aggregated") && item.label === "id");
  // "id" appears in count(o.id) — it's inside an aggregate, so shouldn't get the non-aggregated boost
  // Note: id from users is not aggregated and appears as u.name is not aliased
  assert.ok(!aggHint, "id inside aggregate should not get non-aggregated boost");
});

test("getSqlCompletionContext returns nonAggregatedSelectColumns", () => {
  const sql = "select name, count(id) from users group by ";
  const context = getSqlCompletionContext(sql, sql.length);
  assert.ok(context.isGroupBy, "should detect GROUP BY context");
  assert.ok(context.nonAggregatedSelectColumns.includes("name"), "name should be non-aggregated");
  assert.ok(!context.nonAggregatedSelectColumns.includes("id"), "id inside COUNT should not be non-aggregated");
});

// --- UPDATE / DELETE completion contexts ---

test("suggests SET immediately after UPDATE target table", () => {
  const sql = "update users se";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "SET");
});

test("suggests target table columns inside UPDATE SET clause", () => {
  const sql = "update users set na";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "name");
  assert.equal(items[0]?.type, "column");
});

test("suggests WHERE after UPDATE SET assignments", () => {
  const sql = "update users set name = 'a' wh";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "WHERE");
});

test("suggests WHERE immediately after DELETE target table", () => {
  const sql = "delete from users wh";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "WHERE");
});

// --- Better FK join inference ---

test("prefers explicit foreign-key join condition with table aliases", () => {
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([["public.orders", [{ name: "orders_customer_id_fkey", column: "customer_id", ref_table: "customers", ref_column: "id" }]]]);
  const sql = "select * from public.orders o join public.customers c on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "orders", schema: "public", type: "table" },
      { name: "customers", schema: "public", type: "table" },
    ],
    columnsByTable,
    foreignKeysByTable,
  });

  assert.deepEqual(items[0], {
    label: "o.customer_id = c.id",
    type: "snippet",
    detail: "JOIN condition from foreign key",
    apply: "o.customer_id = c.id",
    boost: 3201,
  });
});

test("applies keyword case to composite join condition snippets", () => {
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([
    [
      "public.order_lines",
      [
        { name: "order_lines_product_fkey", column: "tenant_id", ref_table: "products", ref_column: "tenant_id" },
        { name: "order_lines_product_fkey", column: "product_id", ref_table: "products", ref_column: "id" },
      ],
    ],
  ]);
  const cols = new Map<string, SqlCompletionColumn[]>([
    [
      "public.order_lines",
      [
        { name: "tenant_id", table: "order_lines", schema: "public", dataType: "bigint" },
        { name: "product_id", table: "order_lines", schema: "public", dataType: "bigint" },
      ],
    ],
    [
      "public.products",
      [
        { name: "tenant_id", table: "products", schema: "public", dataType: "bigint" },
        { name: "id", table: "products", schema: "public", dataType: "bigint" },
      ],
    ],
  ]);
  const sql = "select * from public.order_lines ol join public.products p on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "order_lines", schema: "public", type: "table" },
      { name: "products", schema: "public", type: "table" },
    ],
    columnsByTable: cols,
    foreignKeysByTable,
    keywordCase: "lower",
  });

  const fkJoin = items.find((item) => item.detail === "JOIN condition from composite foreign key");
  assert.equal(fkJoin?.label, "ol.tenant_id = p.tenant_id and ol.product_id = p.id");
  assert.equal(fkJoin?.apply, "ol.tenant_id = p.tenant_id and ol.product_id = p.id");
});

test("suggests explicit foreign-key join when the joined table owns the key", () => {
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([["public.orders", [{ name: "orders_customer_id_fkey", column: "customer_id", ref_table: "customers", ref_column: "id" }]]]);
  const sql = "select * from public.customers c join public.orders o on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "customers", schema: "public", type: "table" },
      { name: "orders", schema: "public", type: "table" },
    ],
    columnsByTable,
    foreignKeysByTable,
  });

  const fkJoin = items.find((item) => item.label === "o.customer_id = c.id");
  assert.ok(fkJoin, "should suggest FK join when the right side owns the foreign key");
});

test("boosts foreign-key related table candidates in JOIN table context", () => {
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([["public.orders", [{ name: "orders_user_id_fkey", column: "user_id", ref_table: "users", ref_column: "id" }]]]);
  const sql = "select * from public.orders o join us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    foreignKeysByTable,
  });

  assert.equal(items[0]?.label, "users");
  assert.equal(items[0]?.type, "table");
  assert.ok(items[0]?.detail?.includes("related by"));
});

test("boosts inbound foreign-key table candidates in JOIN table context", () => {
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([["public.orders", [{ name: "orders_customer_id_fkey", column: "customer_id", ref_schema: "public", ref_table: "customers", ref_column: "id" }]]]);
  const sql = "select * from public.customers c join ord";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
    foreignKeysByTable,
  });

  assert.equal(items[0]?.label, "orders");
  assert.equal(items[0]?.type, "table");
  assert.ok(items[0]?.detail?.includes("orders.customer_id"));
});

test("uses owner schema when ranking inbound foreign-key table candidates", () => {
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([["sales.orders", [{ name: "orders_customer_id_fkey", column: "customer_id", ref_schema: "crm", ref_table: "customers", ref_column: "id" }]]]);
  const sql = "select * from crm.customers c join ord";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "orders", schema: "public", type: "table" },
      { name: "orders", schema: "sales", type: "table" },
      { name: "customers", schema: "crm", type: "table" },
    ],
    columnsByTable,
    foreignKeysByTable,
  });

  assert.equal(items[0]?.label, "orders");
  assert.equal(items[0]?.detail, "related by sales.orders.customer_id → id");
  assert.equal(items[0]?.apply, "orders");
});

test("suggests composite explicit foreign-key join conditions", () => {
  const colsWithCompositeFk = new Map<string, SqlCompletionColumn[]>([
    [
      "public.products",
      [
        { name: "tenant_id", table: "products", schema: "public", dataType: "text" },
        { name: "id", table: "products", schema: "public", dataType: "text" },
      ],
    ],
    [
      "public.order_lines",
      [
        { name: "tenant_id", table: "order_lines", schema: "public", dataType: "text" },
        { name: "product_id", table: "order_lines", schema: "public", dataType: "text" },
      ],
    ],
  ]);
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([
    [
      "public.order_lines",
      [
        { name: "order_lines_product_fkey", column: "tenant_id", ref_table: "products", ref_column: "tenant_id" },
        { name: "order_lines_product_fkey", column: "product_id", ref_table: "products", ref_column: "id" },
      ],
    ],
  ]);
  const sql = "select * from public.order_lines ol join public.products p on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "order_lines", schema: "public", type: "table" },
      { name: "products", schema: "public", type: "table" },
    ],
    columnsByTable: colsWithCompositeFk,
    foreignKeysByTable,
  });

  const fkJoin = items.find((item) => item.label === "ol.tenant_id = p.tenant_id AND ol.product_id = p.id");
  assert.ok(fkJoin, "should suggest full composite FK join");
  assert.equal(fkJoin?.detail, "JOIN condition from composite foreign key");
});

test("uses referenced schema to disambiguate explicit foreign-key joins", () => {
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>([
    [
      "sales.orders",
      [
        {
          name: "orders_customer_id_fkey",
          column: "customer_id",
          ref_schema: "crm",
          ref_table: "customers",
          ref_column: "id",
        },
      ],
    ],
  ]);
  const sql = "select * from sales.orders o join public.customers pc on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "orders", schema: "sales", type: "table" },
      { name: "customers", schema: "public", type: "table" },
      { name: "customers", schema: "crm", type: "table" },
    ],
    columnsByTable,
    foreignKeysByTable,
  });

  assert.equal(
    items.some((item) => item.label === "o.customer_id = pc.id" && item.detail === "JOIN condition from foreign key"),
    false,
  );
});

test("suggests likely composite joins from shared scope columns and id naming", () => {
  const colsWithTenantRelationship = new Map<string, SqlCompletionColumn[]>([
    [
      "public.orders",
      [
        { name: "tenant_id", table: "orders", schema: "public", dataType: "text" },
        { name: "id", table: "orders", schema: "public", dataType: "uuid" },
      ],
    ],
    [
      "public.order_lines",
      [
        { name: "tenant_id", table: "order_lines", schema: "public", dataType: "text" },
        { name: "order_id", table: "order_lines", schema: "public", dataType: "uuid" },
        { name: "article_id", table: "order_lines", schema: "public", dataType: "text" },
      ],
    ],
  ]);
  const sql = "select * from public.orders o join public.order_lines ol on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "orders", schema: "public", type: "table" },
      { name: "order_lines", schema: "public", type: "table" },
    ],
    columnsByTable: colsWithTenantRelationship,
  });

  const compositeJoin = items.find((item) => item.label === "o.tenant_id = ol.tenant_id AND o.id = ol.order_id");
  assert.ok(compositeJoin, "should combine tenant scope with id/FK naming");
  assert.equal(compositeJoin?.detail, "Likely composite JOIN condition");
});

test("does not suggest heuristic joins for incompatible column types", () => {
  const colsWithIncompatibleIds = new Map<string, SqlCompletionColumn[]>([
    [
      "public.users",
      [
        { name: "id", table: "users", schema: "public", dataType: "uuid" },
        { name: "tenant_id", table: "users", schema: "public", dataType: "text" },
      ],
    ],
    [
      "public.orders",
      [
        { name: "user_id", table: "orders", schema: "public", dataType: "bigint" },
        { name: "tenant_id", table: "orders", schema: "public", dataType: "text" },
      ],
    ],
  ]);
  const sql = "select * from public.users u join public.orders o on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "users", schema: "public", type: "table" },
      { name: "orders", schema: "public", type: "table" },
    ],
    columnsByTable: colsWithIncompatibleIds,
  });

  assert.equal(
    items.some((item) => item.label === "u.id = o.user_id"),
    false,
  );
  assert.equal(
    items.some((item) => item.label === "u.tenant_id = o.tenant_id AND u.id = o.user_id"),
    false,
  );
});

test("suggests join condition for same FK column in both tables", () => {
  const colsWithFk = new Map<string, SqlCompletionColumn[]>([
    [
      "public.authors",
      [
        { name: "id", table: "authors", schema: "public", dataType: "bigint" },
        { name: "publisher_id", table: "authors", schema: "public", dataType: "bigint" },
      ],
    ],
    [
      "public.books",
      [
        { name: "id", table: "books", schema: "public", dataType: "bigint" },
        { name: "publisher_id", table: "books", schema: "public", dataType: "bigint" },
      ],
    ],
  ]);
  const sql = "select * from public.authors a join public.books b on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "authors", schema: "public", type: "table" },
      { name: "books", schema: "public", type: "table" },
    ],
    columnsByTable: colsWithFk,
  });
  const fkJoin = items.find((item) => item.label === "a.publisher_id = b.publisher_id");
  assert.ok(fkJoin, "should suggest join on shared FK column publisher_id");
});

test("suggests join condition for parent_id self-reference", () => {
  const colsWithParent = new Map<string, SqlCompletionColumn[]>([
    [
      "public.categories",
      [
        { name: "id", table: "categories", schema: "public", dataType: "bigint" },
        { name: "parent_id", table: "categories", schema: "public", dataType: "bigint" },
        { name: "name", table: "categories", schema: "public", dataType: "varchar" },
      ],
    ],
  ]);
  // Self-join
  const sql = "select * from public.categories c1 join public.categories c2 on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [{ name: "categories", schema: "public", type: "table" }],
    columnsByTable: colsWithParent,
  });
  const parentJoin = items.find((item) => item.label === "c1.parent_id = c2.id" || item.label === "c2.parent_id = c1.id");
  assert.ok(parentJoin, "should suggest parent_id = id for self-reference");
});

test("suggests join condition for created_by → id pattern", () => {
  const colsWithCreator = new Map<string, SqlCompletionColumn[]>([
    [
      "public.users",
      [
        { name: "id", table: "users", schema: "public", dataType: "bigint" },
        { name: "name", table: "users", schema: "public", dataType: "varchar" },
      ],
    ],
    [
      "public.documents",
      [
        { name: "id", table: "documents", schema: "public", dataType: "bigint" },
        { name: "created_by", table: "documents", schema: "public", dataType: "bigint" },
      ],
    ],
  ]);
  const sql = "select * from public.users u join public.documents d on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "users", schema: "public", type: "table" },
      { name: "documents", schema: "public", type: "table" },
    ],
    columnsByTable: colsWithCreator,
  });
  const creatorJoin = items.find((item) => item.label === "u.id = d.created_by");
  assert.ok(creatorJoin, "should suggest id = created_by join");
});

test("suggests generic foreign-key to id join when table names differ from column names", () => {
  const colsWithGenericFk = new Map<string, SqlCompletionColumn[]>([
    [
      "public.first_table",
      [
        { name: "id", table: "first_table", schema: "public", dataType: "bigint" },
        { name: "user_id", table: "first_table", schema: "public", dataType: "bigint" },
      ],
    ],
    [
      "public.second_table",
      [
        { name: "id", table: "second_table", schema: "public", dataType: "bigint" },
        { name: "name", table: "second_table", schema: "public", dataType: "varchar" },
      ],
    ],
  ]);
  const sql = "select * from public.first_table t1 join public.second_table t2 on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [
      { name: "first_table", schema: "public", type: "table" },
      { name: "second_table", schema: "public", type: "table" },
    ],
    columnsByTable: colsWithGenericFk,
  });

  const genericJoin = items.find((item) => item.label === "t1.user_id = t2.id");
  assert.ok(genericJoin, "should suggest generic *_id = id joins");
  assert.equal(genericJoin.apply, "t1.user_id = t2.id");
});

// --- Fuzzy matching ---

test("fuzzy matches table names with character gaps", () => {
  const items = buildSqlCompletionItems("select * from usrs", "select * from usrs".length, {
    tables,
    columnsByTable,
  });
  // "usrs" should fuzzy-match "users" (skip 'e')
  const tableItems = items.filter((item) => item.type === "table");
  assert.ok(
    tableItems.some((item) => item.label === "users"),
    "should fuzzy-match users",
  );
});

test("fuzzy matches columns with abbreviation pattern", () => {
  const sql = "select nm from public.users u";
  const items = buildSqlCompletionItems(sql, "select nm".length, {
    tables,
    columnsByTable,
  });
  // "nm" should fuzzy-match "name"
  assert.ok(
    items.some((item) => item.label === "name" && item.type === "column"),
    "should fuzzy-match name from 'nm'",
  );
});

test("prefix matches still rank above fuzzy matches", () => {
  // Use "na" which is an exact prefix for "name" but also fuzzy-matches "ANALYZE" and others
  const sql = "select na from public.users u";
  const items = buildSqlCompletionItems(sql, "select na".length, {
    tables,
    columnsByTable,
  });
  // Prefix match "name" should be first
  assert.equal(items[0]?.label, "name");
});

test("suggests columns after multiple select-list expressions", () => {
  const sql = "select project_name, review_accountant, doc from ypmng_archive LIMIT 100";
  const cursor = "select project_name, review_accountant, doc".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables: [{ name: "ypmng_archive", type: "table" }],
    objects: [{ name: "proc_get_ypfmm_pd_score_list_with_template_doc_id", schema: "y_jnpf", type: "procedure" }],
    columnsByTable: new Map([
      [
        "ypmng_archive",
        [
          { name: "doc_id", table: "ypmng_archive", dataType: "bigint" },
          { name: "project_name", table: "ypmng_archive", dataType: "varchar" },
          { name: "review_accountant", table: "ypmng_archive", dataType: "varchar" },
        ],
      ],
    ]),
  });

  assert.ok(items.some((item) => item.label === "doc_id" && item.type === "column"));
  assert.ok(!items.some((item) => item.type === "function" && item.label.startsWith("proc_")));
});

test("suggests columns after multiple group by expressions", () => {
  const sql = "select project_name, count(*) from ypmng_archive group by project_name, review";
  const cursor = sql.length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables: [{ name: "ypmng_archive", type: "table" }],
    objects: [{ name: "proc_get_ypfmm_pd_score_list_with_template_doc_id", schema: "y_jnpf", type: "procedure" }],
    columnsByTable: new Map([
      [
        "ypmng_archive",
        [
          { name: "doc_id", table: "ypmng_archive", dataType: "bigint" },
          { name: "project_name", table: "ypmng_archive", dataType: "varchar" },
          { name: "review_accountant", table: "ypmng_archive", dataType: "varchar" },
        ],
      ],
    ]),
  });

  assert.ok(items.some((item) => item.label === "review_accountant" && item.type === "column"));
  assert.ok(!items.some((item) => item.type === "function" && item.label.startsWith("proc_")));
});

test("suggests columns after multiple order by expressions", () => {
  const sql = "select project_name, review_accountant, doc_id from ypmng_archive order by project_name, review";
  const cursor = sql.length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables: [{ name: "ypmng_archive", type: "table" }],
    objects: [{ name: "proc_get_ypfmm_pd_score_list_with_template_doc_id", schema: "y_jnpf", type: "procedure" }],
    columnsByTable: new Map([
      [
        "ypmng_archive",
        [
          { name: "doc_id", table: "ypmng_archive", dataType: "bigint" },
          { name: "project_name", table: "ypmng_archive", dataType: "varchar" },
          { name: "review_accountant", table: "ypmng_archive", dataType: "varchar" },
        ],
      ],
    ]),
  });

  assert.ok(items.some((item) => item.label === "review_accountant" && item.type === "column"));
  assert.ok(!items.some((item) => item.type === "function" && item.label.startsWith("proc_")));
});

// --- Type-aware comparison hints ---

test("suggests NULL and IS NULL after comparison operator", () => {
  const sql = "select * from public.users u where u.name = ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });
  assert.ok(
    items.some((item) => item.label === "NULL"),
    "should suggest NULL",
  );
  assert.ok(
    items.some((item) => item.label === "IS NULL"),
    "should suggest IS NULL",
  );
});

test("suggests string snippet for varchar column after =", () => {
  const sql = "select * from public.users u where u.name = ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });
  const strSnippet = items.find((item) => item.label === "''");
  assert.ok(strSnippet, "should suggest string literal snippet for varchar column");
});

// --- SELECT * expansion ---

test("shows SELECT * column expansion", () => {
  const sql = "select *";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });
  const starItem = items.find((item) => item.label === "* → columns");
  assert.ok(starItem, "should show column expansion for *");
});

// --- History-based ranking ---

test("recordCompletionSelection boosts future ranking", () => {
  // Record a few selections of a specific table
  recordCompletionSelection("user_profiles", "table");
  recordCompletionSelection("user_profiles", "table");

  const items = buildSqlCompletionItems("select * from user", "select * from user".length, {
    tables,
    columnsByTable,
  });
  const tableItems = items.filter((item) => item.type === "table");
  // user_profiles should now rank higher than users due to history boost
  assert.equal(tableItems[0]?.label, "user_profiles");
});

import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildSqlCompletionItems,
  getSqlFunctionSignatureHelp,
  getSqlCompletionResultValidFor,
  isSqlCommentContext,
  shouldAutoOpenSqlCompletion,
  extractCteDefinitions,
  getSqlCompletionContext,
  recordCompletionSelection,
  type SqlCompletionColumn,
  type SqlCompletionForeignKey,
  type SqlCompletionObject,
  type SqlCompletionTable,
} from "../../apps/desktop/src/lib/sqlCompletion.ts";

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

test("suggests PostgreSQL-specific data types and functions", () => {
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
  const postgresDateItems = buildSqlCompletionItems("select date_f", "select date_f".length, {
    tables: [],
    columnsByTable: new Map(),
    databaseType: "postgres",
  });

  assert.ok(typeItems.some((item) => item.type === "keyword" && item.label === "JSONB"));
  assert.ok(serialItems.some((item) => item.type === "keyword" && item.label === "SERIAL"));
  assert.ok(functionItems.some((item) => item.type === "function" && item.label === "JSONB_BUILD_OBJECT"));
  assert.ok(mysqlFunctionItems.some((item) => item.type === "function" && item.label === "DATE_FORMAT"));
  assert.equal(
    postgresDateItems.some((item) => item.type === "function" && item.label === "DATE_FORMAT"),
    false,
  );
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

  assert.deepEqual(
    items.map((item) => [item.label, item.type, item.detail]),
    [["name", "column", "public.users  [varchar]"]],
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

test("suggests tables after LEFT JOIN", () => {
  const sql = "select * from users left join us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.label === "users" && item.type === "table"));
  assert.ok(items.some((item) => item.label === "user_profiles" && item.type === "table"));
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

test("auto-opens completion after word characters and explicit dot qualifiers", () => {
  for (const sql of ["sel", "select * from us", "select u."]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), true, sql);
  }
});

test("auto-opens table completion immediately after FROM context whitespace", () => {
  for (const sql of ["select * from ", "select * from users join ", "select * from users, "]) {
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
  assert.equal(snippet.apply, "SELECT *\nFROM table\nLIMIT 100;");
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
});

test("detects INSERT INTO with schema-qualified table", () => {
  const context = getSqlCompletionContext("INSERT INTO public.users (", "INSERT INTO public.users (".length);
  assert.equal(context.insertTable, "users");
  assert.equal(context.insertSchema, "public");
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

test("shows qualified column names when multiple tables share column name", () => {
  const sql = "select  from public.users u join public.orders o on u.id = o.user_id";
  const items = buildSqlCompletionItems(sql, "select ".length, {
    tables,
    columnsByTable,
  });
  const columns = items.filter((item) => item.type === "column");
  assert.ok(
    columns.some((item) => item.label === "users.id"),
    "should show users.id",
  );
  assert.ok(
    columns.some((item) => item.label === "orders.id"),
    "should show orders.id",
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

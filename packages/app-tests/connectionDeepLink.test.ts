import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseConnectionDeepLink } from "../../apps/desktop/src/lib/connection/connectionDeepLink.ts";

test("parses dbx connection deep link query fields", () => {
  const draft = parseConnectionDeepLink("dbx://connection/new?type=postgres&host=db.internal&port=15432&user=app&database=orders&name=Orders");

  assert.deepEqual(draft, {
    name: "Orders",
    dbType: "postgres",
    driverProfile: "postgres",
    driverLabel: "PostgreSQL",
    host: "db.internal",
    port: 15432,
    username: "app",
    password: undefined,
    database: "orders",
    urlParams: undefined,
    ssl: false,
  });
});

test("parses encoded database URL with password", () => {
  const draft = parseConnectionDeepLink("dbx://connection/new?url=postgres%3A%2F%2Fapp%3Asecret%40db.internal%3A5432%2Forders%3Fsslmode%3Drequire");

  assert.equal(draft?.dbType, "postgres");
  assert.equal(draft?.driverProfile, "postgres");
  assert.equal(draft?.host, "db.internal");
  assert.equal(draft?.port, 5432);
  assert.equal(draft?.username, "app");
  assert.equal(draft?.password, "secret");
  assert.equal(draft?.database, "orders");
  assert.equal(draft?.urlParams, "sslmode=require");
});

test("preserves explicit SQL Server default port from nested URLs", () => {
  const nested = encodeURIComponent("sqlserver://sa:secret@db.internal:1433/erp");
  const draft = parseConnectionDeepLink(`dbx://connection/new?url=${nested}`);

  assert.equal(draft?.dbType, "sqlserver");
  assert.equal(draft?.port, 1433);
  assert.equal(draft?.portExplicit, true);
});

test("marks top-level SQL Server ports explicit for one-time links", () => {
  const draft = parseConnectionDeepLink("dbx://connection/new?type=sqlserver&host=db\\instance&port=1433&one_time=1");

  assert.equal(draft?.port, 1433);
  assert.equal(draft?.portExplicit, true);
  assert.equal(draft?.oneTime, true);
});

test("uses the nested database URL name as connection name", () => {
  const nested = encodeURIComponent("mysql://root:123456@localhost/?name=%E5%85%AC%E5%8F%B8+-+%E6%9C%AC%E5%9C%B0Docker&charset=utf8mb4");
  const draft = parseConnectionDeepLink(`dbx://connection/new?url=${nested}`);

  assert.equal(draft?.name, "公司 - 本地Docker");
  assert.equal(draft?.dbType, "mysql");
  assert.equal(draft?.host, "localhost");
  assert.equal(draft?.urlParams, "charset=utf8mb4");
});

test("top-level deep link name overrides nested database URL name", () => {
  const nested = encodeURIComponent("mysql://root@localhost/?name=Nested");
  const draft = parseConnectionDeepLink(`dbx://connection/new?url=${nested}&name=Top+Level`);

  assert.equal(draft?.name, "Top Level");
});

test("allows password query field to override database URL password", () => {
  const draft = parseConnectionDeepLink("dbx://connection/new?url=postgres%3A%2F%2Fapp%3Asecret%40db.internal%3A5432%2Forders&password=override");

  assert.equal(draft?.password, "override");
});

test("parses boolean control parameters consistently", () => {
  const draft = parseConnectionDeepLink("dbx://connection/new?type=mysql&ssl=1&one_time=yes");

  assert.equal(draft?.ssl, true);
  assert.equal(draft?.oneTime, true);
});

test("ignores unsupported dbx deep link targets", () => {
  assert.equal(parseConnectionDeepLink("dbx://query/open?sql=select%201"), null);
  assert.equal(parseConnectionDeepLink("dbx://connections/new?type=postgres"), null);
});

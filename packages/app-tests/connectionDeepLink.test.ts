import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseConnectionDeepLink, parseConnectionDeepLinkUpdate } from "../../apps/desktop/src/lib/connection/connectionDeepLink.ts";

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

test("credential updates contain only explicit fields and do not apply new-connection defaults", () => {
  const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-connection&user=new-token&password=new-token");

  assert.deepEqual(update, {
    connectionId: "saved-connection",
    patch: { username: "new-token", password: "new-token" },
  });
  assert.deepEqual(parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-connection"), {
    connectionId: "saved-connection",
    patch: {},
  });
});

test("update links preserve encoded credentials and explicit empty fields", () => {
  const link = new URL("dbx://connection/new");
  const username = " user + &=#/%中文 ";
  const password = " password + &=#/%中文\t ";
  for (const [key, value] of Object.entries({ id: "saved-connection", v: "1", name: " Orders ", host: " db.internal ", port: "15432", user: username, password, database: "", url_params: "", ssl: "false" })) {
    link.searchParams.set(key, value);
  }

  assert.deepEqual(parseConnectionDeepLinkUpdate(link.toString()), {
    connectionId: "saved-connection",
    patch: { name: "Orders", host: "db.internal", port: 15432, username, password, database: "", urlParams: "", ssl: false },
  });
  assert.deepEqual(parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-connection&user=&password="), {
    connectionId: "saved-connection",
    patch: { username: "", password: "" },
  });
});

test("update parser leaves links without an ID on the existing create path", () => {
  assert.equal(parseConnectionDeepLinkUpdate("dbx://connection/new?type=mysql&host=db.internal&one_time=true"), null);
  assert.equal(parseConnectionDeepLink("dbx://connection/new?type=mysql&host=db.internal&one_time=true")?.oneTime, true);
});

test("ID-bearing links can never silently create new connections", () => {
  for (const query of ["id=saved-connection", "id=", "id=%20%20", "id=a&id=b", "id=%00"]) {
    assert.throws(() => parseConnectionDeepLink(`dbx://connection/new?${query}`), /cannot create a new connection/);
  }
  for (const query of ["id=", "id=%20%20", "id=%00", "id=%0Asaved-connection"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?${query}`), /valid connection ID/);
  }
});

test("update links reject ambiguous parameters and profile or automatic-action controls", () => {
  for (const query of ["id=another", "password=one&password=two", "port=3306&port=3307", "ssl=true&ssl=false"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-connection&${query}`), /Duplicate connection update parameter/);
  }
  for (const query of ["type=mysql", "url=mysql%3A%2F%2Froot%40other.internal", "one_time=true", "one_time=false", "auto_save=true", "auto_connect=true", "save_password=true", "read_only=false", "unknown=value"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-connection&${query}`), /Unsupported connection update parameter/);
  }
});

test("update links validate explicit port, SSL, version, and required display fields", () => {
  for (const port of ["", "0", "65536", "-1", "3306.5", "1e3", "0xff", "invalid"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-connection&port=${port}`), /Invalid connection update port/);
  }
  for (const ssl of ["", "maybe", "2"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-connection&ssl=${ssl}`), /Invalid connection update SSL/);
  }
  for (const version of ["", "2"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-connection&v=${version}`), /Unsupported connection update version/);
  }
  for (const key of ["name", "host"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-connection&${key}=%20`), /cannot be empty/);
  }
  assert.equal(parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-connection&ssl=YES")?.patch.ssl, true);
  assert.equal(parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-connection&ssl=off")?.patch.ssl, false);
});

test("update links enforce the protocol target and reject ambiguous authority or fragments", () => {
  for (const link of ["not-a-url", "https://connection/new?id=saved-connection", "dbx://connection/edit?id=saved-connection", "dbx://connection/newer?id=saved-connection", "dbx://connections/new?id=saved-connection"]) {
    assert.equal(parseConnectionDeepLinkUpdate(link), null);
  }
  for (const link of ["dbx://user:secret@connection/new?id=saved-connection", "dbx://connection:123/new?id=saved-connection", "dbx://connection/new?id=saved-connection#password=secret"]) {
    assert.throws(() => parseConnectionDeepLinkUpdate(link), /Invalid connection update URL/);
  }
});

test("update validation errors do not expose supplied parameter values", () => {
  const secret = "do-not-log-this-secret";
  for (const key of ["port", "ssl", "v", "type"]) {
    assert.throws(
      () => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-connection&${key}=${secret}`),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    );
  }
});

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { applyParsedConnectionUrl, normalizeMongoConnectionString, parseConnectionUrl } from "../../apps/desktop/src/lib/connectionUrl.ts";
import { h2FileJdbcUrlWithPath } from "../../apps/desktop/src/lib/h2Connection.ts";

test("parses postgres connection URLs", () => {
  assert.deepEqual(parseConnectionUrl("postgresql://alice:secret@db.example.com:5433/app?sslmode=require"), {
    dbType: "postgres",
    driverProfile: "postgres",
    driverLabel: "PostgreSQL",
    host: "db.example.com",
    port: 5433,
    username: "alice",
    password: "secret",
    database: "app",
    urlParams: "sslmode=require",
    ssl: true,
  });
});

test("parses KWDB connection URLs", () => {
  assert.deepEqual(parseConnectionUrl("kwdb://root:secret@kw.example.com/defaultdb?sslmode=require"), {
    dbType: "kwdb",
    driverProfile: "kwdb",
    driverLabel: "KWDB",
    host: "kw.example.com",
    port: 26257,
    username: "root",
    password: "secret",
    database: "defaultdb",
    urlParams: "sslmode=require",
    ssl: true,
  });
});

test("parses mysql URLs with encoded credentials", () => {
  const parsed = parseConnectionUrl("mysql://root:p%40ss@127.0.0.1/shop?charset=utf8mb4");

  assert.equal(parsed.dbType, "mysql");
  assert.equal(parsed.driverProfile, "mysql");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 3306);
  assert.equal(parsed.username, "root");
  assert.equal(parsed.password, "p@ss");
  assert.equal(parsed.database, "shop");
  assert.equal(parsed.urlParams, "charset=utf8mb4");
});

test("parses mysql URL name as decoded connection name", () => {
  const parsed = parseConnectionUrl("mysql://root:123456@localhost/?name=%E5%85%AC%E5%8F%B8+-+%E6%9C%AC%E5%9C%B0Docker&charset=utf8mb4");

  assert.equal(parsed.name, "公司 - 本地Docker");
  assert.equal(parsed.host, "localhost");
  assert.equal(parsed.username, "root");
  assert.equal(parsed.password, "123456");
  assert.equal(parsed.urlParams, "charset=utf8mb4");
});

test("consumes mysql URL name when it is the only URL param", () => {
  const parsed = parseConnectionUrl("mysql://root:123456@localhost/?name=%E5%85%AC%E5%8F%B8+-+%E6%9C%AC%E5%9C%B0Docker");

  assert.equal(parsed.name, "公司 - 本地Docker");
  assert.equal(parsed.urlParams, "");
});

test("removes only the connection name from URL params", () => {
  const parsed = parseConnectionUrl("mysql://root@localhost/app?Name=Analytics+Local&ssl-mode=required");

  assert.equal(parsed.name, "Analytics Local");
  assert.equal(parsed.database, "app");
  assert.equal(parsed.urlParams, "ssl-mode=required");
  assert.equal(parsed.ssl, true);
});

test("parses mysql TLS URL params into the SSL switch state", () => {
  assert.equal(parseConnectionUrl("mysql://root@tidb.example.com:4000/test?ssl-mode=required").ssl, true);
  assert.equal(parseConnectionUrl("mysql://root@tidb.example.com:4000/test?require_ssl=true").ssl, true);
});

test("parses TiDB Cloud MySQL URLs as TLS connections", () => {
  const parsed = parseConnectionUrl("mysql://root:secret@gateway01.us-west-2.prod.aws.tidbcloud.com:4000/test");

  assert.equal(parsed.dbType, "mysql");
  assert.equal(parsed.ssl, true);
});

test("parses MySQL JDBC user and password URL params as credentials", () => {
  const parsed = parseConnectionUrl("jdbc:mysql://127.0.0.1:1234/example?user=admin&password=pwd&useUnicode=true&characterEncoding=UTF8&useSSL=false");

  assert.equal(parsed.dbType, "mysql");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 1234);
  assert.equal(parsed.username, "admin");
  assert.equal(parsed.password, "pwd");
  assert.equal(parsed.database, "example");
  assert.equal(parsed.urlParams, "useUnicode=true&characterEncoding=UTF8&useSSL=false");
});

test("leaves non-JDBC MySQL user and password URL params untouched", () => {
  const parsed = parseConnectionUrl("mysql://127.0.0.1:1234/example?user=admin&password=pwd&charset=utf8mb4");

  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.urlParams, "user=admin&password=pwd&charset=utf8mb4");
});

test("parses Redis insecure TLS URL fragments into URL params", () => {
  const parsed = parseConnectionUrl("rediss://default:secret@redis.example.com:6379/0#insecure");

  assert.equal(parsed.dbType, "redis");
  assert.equal(parsed.host, "redis.example.com");
  assert.equal(parsed.port, 6379);
  assert.equal(parsed.username, "default");
  assert.equal(parsed.password, "secret");
  assert.equal(parsed.database, "0");
  assert.equal(parsed.urlParams, "insecure=true");
  assert.equal(parsed.ssl, true);
});

test("parses JDBC URLs by using the inner database URL", () => {
  const postgres = parseConnectionUrl("jdbc:postgresql://alice:secret@db.example.com:5433/app?sslmode=require");
  assert.equal(postgres.dbType, "postgres");
  assert.equal(postgres.driverProfile, "postgres");
  assert.equal(postgres.host, "db.example.com");
  assert.equal(postgres.port, 5433);
  assert.equal(postgres.username, "alice");
  assert.equal(postgres.password, "secret");
  assert.equal(postgres.database, "app");
  assert.equal(postgres.urlParams, "sslmode=require");

  const mysql = parseConnectionUrl("jdbc:mysql://root:p%40ss@127.0.0.1:3307/shop?charset=utf8mb4");
  assert.equal(mysql.dbType, "mysql");
  assert.equal(mysql.driverProfile, "mysql");
  assert.equal(mysql.host, "127.0.0.1");
  assert.equal(mysql.port, 3307);
  assert.equal(mysql.username, "root");
  assert.equal(mysql.password, "p@ss");
  assert.equal(mysql.database, "shop");
  assert.equal(mysql.urlParams, "charset=utf8mb4");
});

test("parses TDengine WebSocket JDBC URLs", () => {
  const parsed = parseConnectionUrl("jdbc:TAOS-WS://root:taosdata@td.example.com:6041/power?timezone=UTC");

  assert.equal(parsed.dbType, "tdengine");
  assert.equal(parsed.driverProfile, "tdengine");
  assert.equal(parsed.driverLabel, "TDengine");
  assert.equal(parsed.host, "td.example.com");
  assert.equal(parsed.port, 6041);
  assert.equal(parsed.username, "root");
  assert.equal(parsed.password, "taosdata");
  assert.equal(parsed.database, "power");
  assert.equal(parsed.urlParams, "timezone=UTC");
});

test("parses XuguDB JDBC URLs", () => {
  const parsed = parseConnectionUrl("jdbc:xugu://alice:secret@xugu.example.com:5138/demo?charset=utf8");

  assert.equal(parsed.dbType, "xugu");
  assert.equal(parsed.driverProfile, "xugu");
  assert.equal(parsed.driverLabel, "XuguDB");
  assert.equal(parsed.host, "xugu.example.com");
  assert.equal(parsed.port, 5138);
  assert.equal(parsed.username, "alice");
  assert.equal(parsed.password, "secret");
  assert.equal(parsed.database, "demo");
  assert.equal(parsed.urlParams, "charset=utf8");
});

test("parses Apache IoTDB JDBC URLs", () => {
  const parsed = parseConnectionUrl("jdbc:iotdb://root:secret@iotdb.example.com:6667?sql_dialect=table");

  assert.equal(parsed.dbType, "iotdb");
  assert.equal(parsed.driverProfile, "iotdb");
  assert.equal(parsed.driverLabel, "Apache IoTDB");
  assert.equal(parsed.host, "iotdb.example.com");
  assert.equal(parsed.port, 6667);
  assert.equal(parsed.username, "root");
  assert.equal(parsed.password, "secret");
  assert.equal(parsed.database, undefined);
  assert.equal(parsed.urlParams, "sql_dialect=table");
});

test("parses GBase 8s JDBC URLs", () => {
  const parsed = parseConnectionUrl("jdbc:gbasedbt-sqli://gbasedbt:secret@gbase.example.com:20013/testdb:GBASEDBTSERVER=gbase01;CLIENT_LOCALE=zh_cn.utf8");

  assert.equal(parsed.dbType, "gbase");
  assert.equal(parsed.driverProfile, "gbase8s");
  assert.equal(parsed.driverLabel, "GBase 8s");
  assert.equal(parsed.host, "gbase.example.com");
  assert.equal(parsed.port, 20013);
  assert.equal(parsed.username, "gbasedbt");
  assert.equal(parsed.password, "secret");
  assert.equal(parsed.database, "testdb");
  assert.equal(parsed.urlParams, "GBASEDBTSERVER=gbase01;CLIENT_LOCALE=zh_cn.utf8");
});

test("parses Informix JDBC URLs with INFORMIXSERVER", () => {
  const parsed = parseConnectionUrl("jdbc:informix-sqli://192.168.1.1:9088/mydb:INFORMIXSERVER=ol_informix");

  assert.equal(parsed.dbType, "informix");
  assert.equal(parsed.driverProfile, "informix");
  assert.equal(parsed.driverLabel, "Informix");
  assert.equal(parsed.host, "192.168.1.1");
  assert.equal(parsed.port, 9088);
  assert.equal(parsed.database, "mydb");
  assert.equal(parsed.urlParams, "INFORMIXSERVER=ol_informix");
});

test("parses Informix JDBC URLs with multiple parameters", () => {
  const parsed = parseConnectionUrl("jdbc:informix-sqli://192.168.1.1:9088/mydb:INFORMIXSERVER=ol_informix;DB_LOCALE=en_US.UTF8");

  assert.equal(parsed.dbType, "informix");
  assert.equal(parsed.host, "192.168.1.1");
  assert.equal(parsed.port, 9088);
  assert.equal(parsed.database, "mydb");
  assert.equal(parsed.urlParams, "INFORMIXSERVER=ol_informix;DB_LOCALE=en_US.UTF8");
});

test("parses Informix JDBC URLs with credentials", () => {
  const parsed = parseConnectionUrl("jdbc:informix-sqli://user:p%40ss@db.example.com:1533/testdb:INFORMIXSERVER=myserver");

  assert.equal(parsed.dbType, "informix");
  assert.equal(parsed.host, "db.example.com");
  assert.equal(parsed.port, 1533);
  assert.equal(parsed.username, "user");
  assert.equal(parsed.password, "p@ss");
  assert.equal(parsed.database, "testdb");
  assert.equal(parsed.urlParams, "INFORMIXSERVER=myserver");
});

test("parses Informix JDBC URLs without extra parameters", () => {
  const parsed = parseConnectionUrl("jdbc:informix-sqli://192.168.1.1:9088/mydb");

  assert.equal(parsed.dbType, "informix");
  assert.equal(parsed.host, "192.168.1.1");
  assert.equal(parsed.port, 9088);
  assert.equal(parsed.database, "mydb");
  assert.equal(parsed.urlParams, "");
});

test("parses UCanAccess JDBC URLs as Access database files", () => {
  const parsed = parseConnectionUrl("jdbc:ucanaccess:///Users/me/data/Northwind.accdb;memory=false");

  assert.equal(parsed.dbType, "access");
  assert.equal(parsed.driverProfile, "access");
  assert.equal(parsed.driverLabel, "Microsoft Access");
  assert.equal(parsed.host, "/Users/me/data/Northwind.accdb");
  assert.equal(parsed.port, 0);
  assert.equal(parsed.database, "Northwind.accdb");
  assert.equal(parsed.connectionString, "jdbc:ucanaccess:///Users/me/data/Northwind.accdb;memory=false");
});

test("parses SQL Server JDBC URLs with semicolon properties", () => {
  const parsed = parseConnectionUrl("jdbc:sqlserver://sql.example.com:1434;databaseName=erp;user=sa;password=s%40cret;encrypt=true");

  assert.equal(parsed.dbType, "sqlserver");
  assert.equal(parsed.driverProfile, "sqlserver");
  assert.equal(parsed.host, "sql.example.com");
  assert.equal(parsed.port, 1434);
  assert.equal(parsed.username, "sa");
  assert.equal(parsed.password, "s@cret");
  assert.equal(parsed.database, "erp");
  assert.equal(parsed.urlParams, "encrypt=true");
});

test("parses H2 split JDBC URLs as file connections", () => {
  const source = "jdbc:h2:split:28:C:/dbx-test/h2/sample-db;AUTO_SERVER=TRUE";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "h2");
  assert.equal(parsed.driverProfile, "h2");
  assert.equal(parsed.driverLabel, "H2");
  assert.equal(parsed.host, "C:/dbx-test/h2/sample-db");
  assert.equal(parsed.port, 0);
  assert.equal(parsed.username, "sa");
  assert.equal(parsed.password, "");
  assert.equal(parsed.database, "sample-db");
  assert.equal(parsed.urlParams, "AUTO_SERVER=TRUE");
  assert.equal(parsed.connectionString, source);
});

test("parses H2 TCP JDBC URLs as server connections", () => {
  const source = "jdbc:h2:tcp://localhost:9123/~/sample-db;USER=sa;PASSWORD=s%40cret;MODE=MySQL";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "h2");
  assert.equal(parsed.driverProfile, "h2");
  assert.equal(parsed.driverLabel, "H2");
  assert.equal(parsed.host, "localhost");
  assert.equal(parsed.port, 9123);
  assert.equal(parsed.username, "sa");
  assert.equal(parsed.password, "s@cret");
  assert.equal(parsed.database, "~/sample-db");
  assert.equal(parsed.urlParams, "MODE=MySQL");
  assert.equal(parsed.ssl, false);
  assert.equal(parsed.connectionString, source);
});

test("keeps typed H2 credentials when JDBC URL does not include them", () => {
  const parsed = parseConnectionUrl("jdbc:h2:split:28:C:/dbx-test/h2/sample-db;AUTO_SERVER=TRUE");
  const applied = applyParsedConnectionUrl({ name: "", db_type: "h2", username: "typed-user", password: "typed-secret" } as any, parsed);

  assert.equal(applied.username, "typed-user");
  assert.equal(applied.password, "typed-secret");
});

test("uses H2 JDBC URL credentials when they are included", () => {
  const parsed = parseConnectionUrl("jdbc:h2:split:28:C:/dbx-test/h2/sample-db;USER=url-user;PASSWORD=url-secret;AUTO_SERVER=TRUE");
  const applied = applyParsedConnectionUrl({ name: "", db_type: "h2", username: "typed-user", password: "typed-secret" } as any, parsed);

  assert.equal(applied.username, "url-user");
  assert.equal(applied.password, "url-secret");
});

test("rebuilds H2 split JDBC URLs with an edited file path", () => {
  assert.equal(h2FileJdbcUrlWithPath("jdbc:h2:split:28:C:/dbx-test/h2/sample-db;AUTO_SERVER=TRUE", "D:/dbx/new-sample.mv.db"), "jdbc:h2:split:28:D:/dbx/new-sample;AUTO_SERVER=TRUE");
});

test("parses Oracle JDBC service URLs", () => {
  const parsed = parseConnectionUrl("jdbc:oracle:thin:@//oracle.example.com:1522/ORCLPDB1");

  assert.equal(parsed.dbType, "oracle");
  assert.equal(parsed.driverProfile, "oracle");
  assert.equal(parsed.host, "oracle.example.com");
  assert.equal(parsed.port, 1522);
  assert.equal(parsed.database, "ORCLPDB1");
  assert.equal(parsed.oracleConnectionType, "service_name");
});

test("parses Oracle JDBC SID URLs", () => {
  const parsed = parseConnectionUrl("jdbc:oracle:thin:@oracle.example.com:1521:ORCL");

  assert.equal(parsed.dbType, "oracle");
  assert.equal(parsed.driverProfile, "oracle");
  assert.equal(parsed.host, "oracle.example.com");
  assert.equal(parsed.port, 1521);
  assert.equal(parsed.database, "ORCL");
  assert.equal(parsed.oracleConnectionType, "sid");
});

test("parses Oracle JDBC descriptors and keeps the original connection string", () => {
  const source = "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=oracle.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "oracle");
  assert.equal(parsed.driverProfile, "oracle");
  assert.equal(parsed.host, "oracle.example.com");
  assert.equal(parsed.port, 1521);
  assert.equal(parsed.database, "orcl");
  assert.equal(parsed.oracleConnectionType, "service_name");
  assert.equal(parsed.connectionString, source);
});

test("keeps MongoDB URLs as connection strings", () => {
  const source = "mongodb+srv://reader:secret@cluster.example.com/app?retryWrites=true";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "mongodb");
  assert.equal(parsed.driverProfile, "mongodb");
  assert.equal(parsed.host, "cluster.example.com");
  assert.equal(parsed.port, 27017);
  assert.equal(parsed.database, "app");
  assert.equal(parsed.connectionString, source);
  assert.equal(parsed.useMongoUrl, true);
  assert.equal(parsed.ssl, true);
});

test("normalizes MongoDB URL credentials when reserved characters can be parsed safely", () => {
  const parsed = parseConnectionUrl("mongodb://reader:pa@ss:word@mongo.example.com/admin?authSource=admin");

  assert.equal(parsed.username, "reader");
  assert.equal(parsed.password, "pa@ss:word");
  assert.equal(parsed.connectionString, "mongodb://reader:pa%40ss%3Aword@mongo.example.com/admin?authSource=admin");
});

test("normalizes invalid percent escapes in MongoDB URL credentials", () => {
  assert.equal(normalizeMongoConnectionString("mongodb://reader:pa%ss@mongo.example.com/admin"), "mongodb://reader:pa%25ss@mongo.example.com/admin");
});

test("uses selected HTTP-compatible profile for HTTP URLs", () => {
  const parsed = parseConnectionUrl("https://search.example.com:9243", "elasticsearch");

  assert.equal(parsed.dbType, "elasticsearch");
  assert.equal(parsed.driverProfile, "elasticsearch");
  assert.equal(parsed.host, "search.example.com");
  assert.equal(parsed.port, 9243);
  assert.equal(parsed.ssl, true);
});

test("parses HTTPS ClickHouse URLs with selected profile", () => {
  const parsed = parseConnectionUrl("https://default:secret@clickhouse.example.com:8443/default?secure=true", "clickhouse");

  assert.equal(parsed.dbType, "clickhouse");
  assert.equal(parsed.driverProfile, "clickhouse");
  assert.equal(parsed.host, "clickhouse.example.com");
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.username, "default");
  assert.equal(parsed.password, "secret");
  assert.equal(parsed.database, "default");
  assert.equal(parsed.urlParams, "secure=true");
  assert.equal(parsed.ssl, true);
});

test("parses MongoDB multi-host replica set URL", () => {
  const source = "mongodb://test:test@1.1.1.1:27017,1.1.1.2:27017,1.1.1.3:27017/admin?authMechanism=SCRAM-SHA-256&authSource=admin&replicaSet=testRS0";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "mongodb");
  assert.equal(parsed.driverProfile, "mongodb");
  assert.equal(parsed.host, "1.1.1.1");
  assert.equal(parsed.port, 27017);
  assert.equal(parsed.username, "test");
  assert.equal(parsed.password, "test");
  assert.equal(parsed.database, "admin");
  assert.equal(parsed.urlParams, "authMechanism=SCRAM-SHA-256&authSource=admin&replicaSet=testRS0");
  assert.equal(parsed.connectionString, source);
  assert.equal(parsed.useMongoUrl, true);
  assert.equal(parsed.ssl, false);
});

test("parses MongoDB single-host URL with replicaSet and auth params", () => {
  const source = "mongodb://test:test@1.1.1.1:27017/?authMechanism=SCRAM-SHA-256&authSource=admin&replicaSet=testRS0";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "mongodb");
  assert.equal(parsed.host, "1.1.1.1");
  assert.equal(parsed.port, 27017);
  assert.equal(parsed.username, "test");
  assert.equal(parsed.password, "test");
  assert.equal(parsed.urlParams, "authMechanism=SCRAM-SHA-256&authSource=admin&replicaSet=testRS0");
  assert.equal(parsed.connectionString, source);
  assert.equal(parsed.useMongoUrl, true);
});

test("parses MongoDB multi-host URL without credentials", () => {
  const source = "mongodb://host1:27017,host2:27017/?replicaSet=rs0";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "mongodb");
  assert.equal(parsed.host, "host1");
  assert.equal(parsed.port, 27017);
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.urlParams, "replicaSet=rs0");
  assert.equal(parsed.connectionString, source);
  assert.equal(parsed.useMongoUrl, true);
});

test("parses MongoDB URL with simple authSource only", () => {
  const source = "mongodb://test:test@1.1.1.1:27017/?authSource=admin";
  const parsed = parseConnectionUrl(source);

  assert.equal(parsed.dbType, "mongodb");
  assert.equal(parsed.host, "1.1.1.1");
  assert.equal(parsed.port, 27017);
  assert.equal(parsed.username, "test");
  assert.equal(parsed.password, "test");
  assert.equal(parsed.urlParams, "authSource=admin");
  assert.equal(parsed.useMongoUrl, true);
});

test("rejects unsupported URL schemes", () => {
  assert.throws(() => parseConnectionUrl("ftp://example.com"), /Unsupported connection URL scheme/);
});

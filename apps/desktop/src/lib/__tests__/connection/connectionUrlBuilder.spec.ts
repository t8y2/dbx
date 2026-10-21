import { describe, expect, it } from "vitest";
import { buildConnectionUrlCopy, CONNECTION_URL_COPY_WITH_PASSWORD_FORMATS, connectionSupportsUrlCopy, connectionUrlCopyFormats, type ConnectionUrlCopyConfig } from "@/lib/connection/connectionUrlBuilder";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

function config(overrides: Partial<ConnectionUrlCopyConfig>): ConnectionUrlCopyConfig {
  return {
    db_type: "postgres",
    host: "db.example.com",
    port: 5432,
    username: "app_user",
    password: "secret",
    database: "appdb",
    url_params: "",
    ssl: false,
    ...overrides,
  };
}

const ASCII_SYMBOLS = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
// `=` stays literal (issue #12304): userinfo and query values split on their
// first separator, so escaping it only made copied passwords differ from the
// stored credential for clients that never percent-decode.
const ENCODED_ASCII_SYMBOLS = "%21%22%23%24%25%26%27%28%29%2A%2B%2C-.%2F%3A%3B%3C=%3E%3F%40%5B%5C%5D%5E_%60%7B%7C%7D~";

describe("OceanBase copy readability and compatibility", () => {
  const oceanbase = (overrides: Partial<ConnectionUrlCopyConfig> = {}) => config({ db_type: "mysql", driver_profile: "oceanbase", port: 2881, username: "admin@tenant@cluster", ...overrides });

  it("keeps tenant names readable across the four copy formats", () => {
    const connection = oceanbase();
    expect(buildConnectionUrlCopy(connection, "url")).toBe("oceanbase://admin@tenant@cluster@db.example.com:2881/appdb");
    expect(buildConnectionUrlCopy(connection, "urlWithPassword")).toBe("oceanbase://admin@tenant@cluster:secret@db.example.com:2881/appdb");
    expect(buildConnectionUrlCopy(connection, "jdbcUrl")).toBe("jdbc:oceanbase://db.example.com:2881/appdb");
    expect(buildConnectionUrlCopy(connection, "jdbcUrlWithCredentials")).toBe("jdbc:oceanbase://db.example.com:2881/appdb?user=admin@tenant@cluster&password=secret");
    expect(connectionUrlCopyFormats(connection)).toEqual(["url", "urlWithPassword", "jdbcUrl", "jdbcUrlWithCredentials", "hostPort"]);
    for (const format of ["url", "urlWithPassword", "jdbcUrlWithCredentials"] as const) {
      const parsed = parseConnectionUrl(buildConnectionUrlCopy(connection, format)!);
      expect(parsed.username).toBe(connection.username);
      expect(parsed.host).toBe(connection.host);
      expect(parsed.port).toBe(2881);
      expect(parsed.password).toBe(format === "url" ? "" : connection.password);
    }
  });

  it("keeps safe punctuation readable without changing ordinary MySQL encoding", () => {
    const username = "u!$()*,=@tenant";
    expect(buildConnectionUrlCopy(oceanbase({ username }), "url")).toContain(username + "@");
    expect(buildConnectionUrlCopy(oceanbase({ password: "p!$()*,=" }), "urlWithPassword")).toContain(":p!$()*,=@");
    expect(buildConnectionUrlCopy(config({ db_type: "mysql", username }), "url")).toContain("u%21%24%28%29%2A%2C=%40tenant@");
  });

  it("round-trips all standard URL credential symbols and IPv6 without losing escaping boundaries", () => {
    const connection = oceanbase({ username: "u" + ASCII_SYMBOLS + "@tenant", password: "p" + ASCII_SYMBOLS, host: "2001:db8::1" });
    const text = buildConnectionUrlCopy(connection, "urlWithPassword")!;
    expect(text).toContain("%27");
    expect(text).toContain("%40");
    const parsed = parseConnectionUrl(text);
    expect(parsed.username).toBe(connection.username);
    expect(parsed.password).toBe(connection.password);
    expect(parsed.port).toBe(connection.port);
    expect(parsed.database).toBe(connection.database);
    expect(new URL(text).hostname).toBe("[2001:db8::1]");
  });

  it("uses literal JDBC property values instead of percent-encoded credentials", () => {
    const value = "a!$()*+,=:@/?[]<>`|^{}\\中文b";
    const text = buildConnectionUrlCopy(oceanbase({ username: value, password: value }), "jdbcUrlWithCredentials")!;
    expect(text).toContain("user=" + value + "&password=" + value);
    expect(parseConnectionUrl(text).username).toBe(value);
    expect(parseConnectionUrl(text).password).toBe(value);
  });

  it.each(["&", ";", "'", '"', "#", "%40", " ", "\n", "\t"])("does not offer a JDBC credential URL that cannot preserve %j", (symbol) => {
    for (const field of ["username", "password"] as const) {
      const connection = oceanbase({ [field]: "a" + symbol + "b" });
      expect(buildConnectionUrlCopy(connection, "jdbcUrlWithCredentials")).toBeNull();
      expect(connectionUrlCopyFormats(connection)).not.toContain("jdbcUrlWithCredentials");
      expect(connectionUrlCopyFormats(connection)).toContain("urlWithPassword");
      expect(parseConnectionUrl(buildConnectionUrlCopy(connection, "urlWithPassword")!)[field]).toBe(connection[field]);
    }
  });

  it("preserves explicit strings while redacting passwords behind raw tenant names", () => {
    const explicit = "oceanbase://admin@tenant:synthetic%40secret@db.example.com:2881/appdb";
    expect(buildConnectionUrlCopy(oceanbase({ connection_string: explicit }), "url")).toBe("oceanbase://admin@tenant:***@db.example.com:2881/appdb");
    expect(buildConnectionUrlCopy(oceanbase({ connection_string: explicit }), "urlWithPassword")).toBe(explicit);
    const jdbc = "jdbc:oceanbase://db.example.com:2881/appdb?user=literal%40tenant&password=secret";
    expect(buildConnectionUrlCopy(oceanbase({ connection_string: jdbc }), "jdbcUrlWithCredentials")).toBe(jdbc);
  });
});

describe("connectionUrlCopyFormats", () => {
  it("lists all formats for a PostgreSQL connection with a stored password", () => {
    expect(connectionUrlCopyFormats(config({}))).toEqual(["url", "urlWithPassword", "jdbcUrl", "jdbcUrlWithCredentials", "hostPort", "dsn", "dsnWithPassword", "psqlCommand"]);
  });

  it("drops every password-inclusive format when no password is stored", () => {
    const formats = connectionUrlCopyFormats(config({ password: "" }));
    for (const format of CONNECTION_URL_COPY_WITH_PASSWORD_FORMATS) {
      expect(formats).not.toContain(format);
    }
    expect(formats).toEqual(["url", "jdbcUrl", "hostPort", "dsn", "psqlCommand"]);
  });

  it("offers an unredacted URL when its query contains the only secret", () => {
    const search = config({ db_type: "elasticsearch", host: "search.example.com", port: 9200, username: "", password: "", database: "", url_params: "token=abc&pretty" });
    expect(buildConnectionUrlCopy(search, "url")).toBe("http://search.example.com:9200?token=***&pretty");
    expect(buildConnectionUrlCopy(search, "urlWithPassword")).toBe("http://search.example.com:9200?token=abc&pretty");
    expect(connectionUrlCopyFormats(search)).toContain("urlWithPassword");
  });

  it("hides everything for file-based connections", () => {
    expect(connectionSupportsUrlCopy(config({ db_type: "sqlite", host: "/data/app.db", port: 0 }))).toBe(false);
    expect(connectionUrlCopyFormats(config({ db_type: "duckdb", host: "/data/app.duckdb", port: 0 }))).toEqual([]);
    expect(connectionUrlCopyFormats(config({ db_type: "h2", host: "/data/app.mv.db", port: 0 }))).toEqual([]);
  });

  it("keeps H2 server mode available through its explicit connection string", () => {
    const formats = connectionUrlCopyFormats(config({ db_type: "h2", host: "db.example.com", port: 9092, connection_string: "jdbc:h2:tcp://db.example.com:9092/~/test" }));
    expect(formats).toEqual(["url", "hostPort"]);
  });

  it("hides URL copy for service-registry and message-queue connections", () => {
    expect(connectionUrlCopyFormats(config({ db_type: "nacos", host: "nacos.example.com", port: 8848 }))).toEqual([]);
    expect(connectionUrlCopyFormats(config({ db_type: "mq", host: "kafka.example.com", port: 9092 }))).toEqual([]);
  });

  it("offers only JDBC formats for hive-family connections", () => {
    const formats = connectionUrlCopyFormats(config({ db_type: "hive", host: "hive.example.com", port: 10000, database: "dw" }));
    expect(formats).toEqual(["jdbcUrl", "jdbcUrlWithCredentials", "hostPort"]);
  });

  it("uses semicolon options when copying an Inceptor JDBC URL", () => {
    const transwarp = config({ db_type: "transwarp", host: "quark.example.com", port: 10000, database: "default", username: "", password: "", url_params: "fetchSize=500" });
    expect(buildConnectionUrlCopy(transwarp, "jdbcUrl")).toBe("jdbc:inceptor2://quark.example.com:10000/default;fetchSize=500");
  });
});

describe("buildConnectionUrlCopy standard URL", () => {
  it("builds a password-free PostgreSQL URL for the primary item", () => {
    expect(buildConnectionUrlCopy(config({}), "url")).toBe("postgresql://app_user@db.example.com:5432/appdb");
  });

  it("embeds credentials only in the explicit with-password variant", () => {
    expect(buildConnectionUrlCopy(config({}), "urlWithPassword")).toBe("postgresql://app_user:secret@db.example.com:5432/appdb");
  });

  it("percent-encodes special characters in credentials and database", () => {
    const text = buildConnectionUrlCopy(config({ username: "user@corp", password: "p@ss:w/ord#", database: "app db" }), "urlWithPassword");
    expect(text).toBe("postgresql://user%40corp:p%40ss%3Aw%2Ford%23@db.example.com:5432/app%20db");
  });

  it("round-trips every ASCII symbol in URL credentials", () => {
    const text = buildConnectionUrlCopy(config({ password: ASCII_SYMBOLS }), "urlWithPassword");
    expect(text).toBe(`postgresql://app_user:${ENCODED_ASCII_SYMBOLS}@db.example.com:5432/appdb`);
    expect(parseConnectionUrl(text ?? "").password).toBe(ASCII_SYMBOLS);
  });

  it("keeps Oracle URL credentials readable instead of escaping `^` as `%5E`", () => {
    const oracle = config({ db_type: "oracle", host: "10.89.67.210", port: 1521, username: "GSU_ZXQ", password: "W^j.U.ZUm5Th", database: "optpdb" });
    const text = buildConnectionUrlCopy(oracle, "urlWithPassword");
    expect(text).toBe("oracle://GSU_ZXQ:W^j.U.ZUm5Th@10.89.67.210:1521/optpdb");
    expect(parseConnectionUrl(text ?? "").password).toBe("W^j.U.ZUm5Th");
  });

  it("still escapes the Oracle URL credentials that would change how the URL is read", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, username: "app_user", password: "p^ss%40#y@x", database: "ORCLPDB1" });
    const text = buildConnectionUrlCopy(oracle, "urlWithPassword");
    expect(text).toBe("oracle://app_user:p^ss%2540%23y%40x@ora.example.com:1521/ORCLPDB1");
    expect(parseConnectionUrl(text ?? "").password).toBe("p^ss%40#y@x");
  });

  it("keeps the full percent-encoding for dialects whose URL a driver consumes", () => {
    expect(buildConnectionUrlCopy(config({ password: "W^j.U" }), "urlWithPassword")).toBe("postgresql://app_user:W%5Ej.U@db.example.com:5432/appdb");
  });

  it("keeps `=` readable in copied URLs instead of escaping it as %3D", () => {
    const password = "p=ss=word";
    const mysql = config({ db_type: "mysql", port: 3306, password });
    const mysqlUrl = buildConnectionUrlCopy(mysql, "urlWithPassword");
    expect(mysqlUrl).toBe("mysql://app_user:p=ss=word@db.example.com:3306/appdb");
    expect(parseConnectionUrl(mysqlUrl ?? "").password).toBe(password);

    const redis = config({ db_type: "redis", port: 6379, username: "", password, database: "0" });
    expect(buildConnectionUrlCopy(redis, "urlWithPassword")).toBe("redis://:p=ss=word@db.example.com:6379/0");

    const oceanbase = config({ db_type: "mysql", port: 2883, driver_profile: "oceanbase", password });
    expect(buildConnectionUrlCopy(oceanbase, "urlWithPassword")).toBe("oceanbase://app_user:p=ss=word@db.example.com:2883/appdb");
  });

  it("preserves credentials that already look percent-encoded", () => {
    const password = "%25%40%5E";
    const text = buildConnectionUrlCopy(config({ password }), "urlWithPassword");
    expect(text).toBe("postgresql://app_user:%2525%2540%255E@db.example.com:5432/appdb");
    expect(parseConnectionUrl(text ?? "").password).toBe(password);
  });

  it("appends url_params and adds sslmode when ssl is enabled", () => {
    expect(buildConnectionUrlCopy(config({ url_params: "application_name=svc" }), "url")).toBe("postgresql://app_user@db.example.com:5432/appdb?application_name=svc");
    expect(buildConnectionUrlCopy(config({ ssl: true, url_params: "application_name=svc" }), "url")).toBe("postgresql://app_user@db.example.com:5432/appdb?application_name=svc&sslmode=require");
    expect(buildConnectionUrlCopy(config({ ssl: true, url_params: "sslmode=verify-full" }), "url")).toBe("postgresql://app_user@db.example.com:5432/appdb?sslmode=verify-full");
  });

  it("honours the database override from a database tree node", () => {
    expect(buildConnectionUrlCopy(config({}), "url", { database: "reporting" })).toBe("postgresql://app_user@db.example.com:5432/reporting");
  });

  it("uses rediss:// when TLS is enabled for Redis", () => {
    const redis = config({ db_type: "redis", host: "cache.example.com", port: 6379, username: "", database: "0", ssl: true });
    expect(buildConnectionUrlCopy(redis, "url")).toBe("rediss://cache.example.com:6379/0");
    expect(buildConnectionUrlCopy(redis, "urlWithPassword")).toBe("rediss://:secret@cache.example.com:6379/0");
  });

  it("falls back to db 0 for non-numeric Redis database values instead of percent-encoding them", () => {
    // Mirrors dbx-core redis_database_index(): "0 --tls --insecure" fails to
    // parse as an index and the backend silently uses 0.
    const redis = config({ db_type: "redis", host: "cache.example.com", port: 6379, username: "coupon", password: "", database: "0 --tls --insecure", url_params: "insecure=true", ssl: true });
    expect(buildConnectionUrlCopy(redis, "url")).toBe("rediss://coupon@cache.example.com:6379/0?insecure=true");
    expect(buildConnectionUrlCopy(config({ db_type: "redis", database: "3" }), "url")).toBe("redis://app_user@db.example.com:5432/3");
  });

  it("maps the MySQL family profiles to their own schemes", () => {
    expect(buildConnectionUrlCopy(config({ db_type: "mysql", port: 3306 }), "url")).toBe("mysql://app_user@db.example.com:3306/appdb");
    expect(buildConnectionUrlCopy(config({ db_type: "mysql", port: 3306, driver_profile: "mariadb" }), "urlWithPassword")).toBe("mariadb://app_user:secret@db.example.com:3306/appdb");
    expect(buildConnectionUrlCopy(config({ db_type: "mysql", port: 2883, driver_profile: "oceanbase" }), "urlWithPassword")).toBe("oceanbase://app_user:secret@db.example.com:2883/appdb");
    expect(buildConnectionUrlCopy(config({ db_type: "doris", port: 9030 }), "urlWithPassword")).toBe("mysql://app_user:secret@db.example.com:9030/appdb");
  });

  it("keeps multi-host endpoints verbatim without an extra port suffix", () => {
    const text = buildConnectionUrlCopy(config({ db_type: "gaussdb", host: "h1.example.com:5432,h2.example.com:5432" }), "urlWithPassword");
    expect(text).toBe("postgresql://app_user:secret@h1.example.com:5432,h2.example.com:5432/appdb");
  });

  it("brackets bare IPv6 hosts", () => {
    expect(buildConnectionUrlCopy(config({ host: "fe80::1" }), "urlWithPassword")).toBe("postgresql://app_user:secret@[fe80::1]:5432/appdb");
  });

  it("redacts explicit connection strings unless the with-password variant is requested", () => {
    const jdbcConfig = config({ db_type: "jdbc", host: "", port: 0, username: "", password: "", database: undefined, connection_string: "jdbc:dremio:direct=drill.example.com:31010;user=analyst;password=s3cret" });
    expect(buildConnectionUrlCopy(jdbcConfig, "url")).toBe("jdbc:dremio:direct=drill.example.com:31010;user=analyst;password=***");
    expect(buildConnectionUrlCopy(jdbcConfig, "urlWithPassword")).toBe(jdbcConfig.connection_string);
    // Credentials embedded in the explicit string count as a copyable secret
    // even though no password field is stored.
    expect(connectionUrlCopyFormats(jdbcConfig)).toEqual(["url", "urlWithPassword"]);
  });

  it("redacts an explicit URL with a password but no username", () => {
    const redis = config({ db_type: "redis", host: "cache.example.com", port: 6379, username: "", password: "", database: "0", connection_string: "redis://:synthetic-secret@cache.example.com:6379/0" });
    expect(buildConnectionUrlCopy(redis, "url")).toBe("redis://:***@cache.example.com:6379/0");
    expect(buildConnectionUrlCopy(redis, "urlWithPassword")).toBe(redis.connection_string);
    expect(connectionUrlCopyFormats(redis)).toContain("urlWithPassword");
    expect(buildConnectionUrlCopy({ ...redis, connection_string: "redis://cache.example.com:6379/0" }, "url")).toBe("redis://cache.example.com:6379/0");
  });
});

describe("buildConnectionUrlCopy JDBC URL", () => {
  it("builds a generic PostgreSQL JDBC URL", () => {
    expect(buildConnectionUrlCopy(config({}), "jdbcUrl")).toBe("jdbc:postgresql://db.example.com:5432/appdb");
    expect(buildConnectionUrlCopy(config({}), "jdbcUrlWithCredentials")).toBe("jdbc:postgresql://db.example.com:5432/appdb?user=app_user&password=secret");
  });

  it.each([
    { db_type: "mysql", port: 3306 },
    { db_type: "postgres", port: 5432 },
  ] as const)("round-trips every ASCII symbol in $db_type JDBC credentials", ({ db_type, port }) => {
    const text = buildConnectionUrlCopy(config({ db_type, port, password: ASCII_SYMBOLS }), "jdbcUrlWithCredentials");
    expect(text).toContain(`password=${ENCODED_ASCII_SYMBOLS}`);
    const encodedPassword = text?.match(/(?:[?&;,:]|^)password=([^&;,:]*)/i)?.[1];
    expect(encodedPassword).toBe(ENCODED_ASCII_SYMBOLS);
    expect(decodeURIComponent(encodedPassword ?? "")).toBe(ASCII_SYMBOLS);
  });

  it("does not double-decode percent-looking MySQL JDBC credentials", () => {
    const password = "%25%40%5E";
    const text = buildConnectionUrlCopy(config({ db_type: "mysql", port: 3306, password }), "jdbcUrlWithCredentials");
    expect(text).toBe("jdbc:mysql://db.example.com:3306/appdb?user=app_user&password=%2525%2540%255E");
    expect(parseConnectionUrl(text ?? "").password).toBe(password);
  });

  it("keeps `=` readable in MySQL-family JDBC credentials", () => {
    const password = "p=ss=word";
    const mysql = config({ db_type: "mysql", port: 3306, password });
    const mysqlUrl = buildConnectionUrlCopy(mysql, "jdbcUrlWithCredentials");
    expect(mysqlUrl).toBe("jdbc:mysql://db.example.com:3306/appdb?user=app_user&password=p=ss=word");
    expect(parseConnectionUrl(mysqlUrl ?? "").password).toBe(password);

    const oceanbase = config({ db_type: "mysql", port: 2883, driver_profile: "oceanbase", password });
    const oceanbaseUrl = buildConnectionUrlCopy(oceanbase, "jdbcUrlWithCredentials");
    expect(oceanbaseUrl).toBe("jdbc:oceanbase://db.example.com:2883/appdb?user=app_user&password=p=ss=word");
    expect(parseConnectionUrl(oceanbaseUrl ?? "").password).toBe(password);
  });

  it("keeps Oracle Easy Connect credentials literal instead of URI-encoding them", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, database: "ORCLPDB1", password: "p^ss%40#y" });
    expect(buildConnectionUrlCopy(oracle, "jdbcUrlWithCredentials")).toBe("jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1?user=app_user&password=p^ss%40#y");
  });

  it("does not offer an Oracle credential URL that would split a property", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, database: "ORCLPDB1", password: "p&ss" });
    expect(buildConnectionUrlCopy(oracle, "jdbcUrlWithCredentials")).toBeNull();
    expect(connectionUrlCopyFormats(oracle)).not.toContain("jdbcUrlWithCredentials");
  });

  it("does not offer an Oracle credential URL that would split at @", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, database: "ORCLPDB1", password: "p@ss" });
    expect(buildConnectionUrlCopy(oracle, "jdbcUrlWithCredentials")).toBeNull();
  });

  it("redacts a percent-encoded password property name accepted by the MySQL importer", () => {
    const mysql = config({ db_type: "mysql", port: 3306, username: "", password: "", url_params: "pass%77ord=synthetic-secret&connectTimeout=5000" });
    const jdbcWithCredentials = buildConnectionUrlCopy(mysql, "jdbcUrlWithCredentials")!;
    expect(parseConnectionUrl(jdbcWithCredentials).password).toBe("synthetic-secret");
    expect(buildConnectionUrlCopy(mysql, "url")).toContain("pass%77ord=***&connectTimeout=5000");
    expect(buildConnectionUrlCopy(mysql, "jdbcUrl")).toContain("pass%77ord=***&connectTimeout=5000");
    expect(connectionUrlCopyFormats(mysql)).toContain("jdbcUrlWithCredentials");
  });

  it("adds driver-specific ssl properties", () => {
    expect(buildConnectionUrlCopy(config({ ssl: true }), "jdbcUrl")).toBe("jdbc:postgresql://db.example.com:5432/appdb?ssl=true");
    expect(buildConnectionUrlCopy(config({ db_type: "mysql", port: 3306, ssl: true }), "jdbcUrl")).toBe("jdbc:mysql://db.example.com:3306/appdb?sslMode=REQUIRED");
  });

  it("uses semicolon properties for SQL Server", () => {
    const sqlserver = config({ db_type: "sqlserver", host: "sql.example.com", port: 1433, database: "appdb" });
    expect(buildConnectionUrlCopy(sqlserver, "jdbcUrl")).toBe("jdbc:sqlserver://sql.example.com:1433;databaseName=appdb");
    expect(buildConnectionUrlCopy(sqlserver, "jdbcUrlWithCredentials")).toBe("jdbc:sqlserver://sql.example.com:1433;databaseName=appdb;user=app_user;password=secret");
    expect(buildConnectionUrlCopy({ ...sqlserver, ssl: true }, "jdbcUrl")).toBe("jdbc:sqlserver://sql.example.com:1433;databaseName=appdb;encrypt=true");
  });

  it("builds Oracle thin URLs for service names and SIDs", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, database: "ORCLPDB1", username: "", password: "" });
    expect(buildConnectionUrlCopy(oracle, "jdbcUrl")).toBe("jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1");
    expect(buildConnectionUrlCopy({ ...oracle, oracle_connection_type: "sid" }, "jdbcUrl")).toBe("jdbc:oracle:thin:@ora.example.com:1521:ORCLPDB1");
  });

  it("keeps Oracle credentials verbatim when they are safe to embed", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, database: "ORCLPDB1", username: "app_user", password: "p^ss%40#y" });
    expect(buildConnectionUrlCopy(oracle, "jdbcUrlWithCredentials")).toBe("jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1?user=app_user&password=p^ss%40#y");
    expect(connectionUrlCopyFormats(oracle)).toContain("jdbcUrlWithCredentials");
  });

  it("omits the Oracle with-credentials item when the password would break the property grammar", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, database: "ORCLPDB1", username: "app_user", password: "p@ss&word" });
    expect(buildConnectionUrlCopy(oracle, "jdbcUrlWithCredentials")).toBeNull();
    expect(connectionUrlCopyFormats(oracle)).not.toContain("jdbcUrlWithCredentials");
    // The plain JDBC URL without credentials stays available.
    expect(buildConnectionUrlCopy(oracle, "jdbcUrl")).toBe("jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1");
  });

  it("omits the Oracle with-credentials item when the username would break the property grammar", () => {
    const oracle = config({ db_type: "oracle", host: "ora.example.com", port: 1521, database: "ORCLPDB1", username: "app@user", password: "secret" });
    expect(buildConnectionUrlCopy(oracle, "jdbcUrlWithCredentials")).toBeNull();
    expect(connectionUrlCopyFormats(oracle)).not.toContain("jdbcUrlWithCredentials");
    expect(buildConnectionUrlCopy(oracle, "jdbcUrl")).toBe("jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1");
  });

  it("redacts explicit jdbc: strings for the plain item and keeps them verbatim for the credentials item", () => {
    const jdbcConfig = config({ db_type: "jdbc", host: "", port: 0, username: "", password: "", database: undefined, connection_string: "jdbc:hive2://zk1:2181,zk2:2181/default;serviceDiscoveryMode=zooKeeper;password=s3cret" });
    expect(buildConnectionUrlCopy(jdbcConfig, "jdbcUrl")).toBe("jdbc:hive2://zk1:2181,zk2:2181/default;serviceDiscoveryMode=zooKeeper;password=***");
    expect(buildConnectionUrlCopy(jdbcConfig, "jdbcUrlWithCredentials")).toBe(jdbcConfig.connection_string);
  });

  it("passes explicit jdbc: strings without secrets through unchanged", () => {
    const jdbcConfig = config({ db_type: "jdbc", host: "", port: 0, username: "", password: "", database: undefined, connection_string: "jdbc:hive2://zk1:2181,zk2:2181/default;serviceDiscoveryMode=zooKeeper" });
    expect(buildConnectionUrlCopy(jdbcConfig, "jdbcUrl")).toBe(jdbcConfig.connection_string);
    expect(buildConnectionUrlCopy(jdbcConfig, "jdbcUrlWithCredentials")).toBe(jdbcConfig.connection_string);
  });

  it("selects dialects by driver profile", () => {
    expect(buildConnectionUrlCopy(config({ db_type: "gaussdb", driver_profile: "gaussdb-m" }), "jdbcUrl")).toBe("jdbc:gaussdb://db.example.com:5432/appdb");
    expect(buildConnectionUrlCopy(config({ db_type: "gaussdb" }), "jdbcUrl")).toBe("jdbc:postgresql://db.example.com:5432/appdb");
    expect(buildConnectionUrlCopy(config({ db_type: "gbase8s", port: 9088, driver_profile: "gbase8s" }), "jdbcUrl")).toBe("jdbc:gbasedbt-sqli://db.example.com:9088/appdb");
    expect(buildConnectionUrlCopy(config({ db_type: "gbase", port: 5258, driver_profile: "gbase8a" }), "jdbcUrl")).toBeNull();
    expect(buildConnectionUrlCopy(config({ db_type: "tdengine", port: 6041 }), "jdbcUrl")).toBe("jdbc:TAOS-RS://db.example.com:6041/appdb");
    expect(buildConnectionUrlCopy(config({ db_type: "tdengine", port: 6030 }), "jdbcUrl")).toBe("jdbc:TAOS://db.example.com:6030/appdb");
  });

  it("hides the JDBC item when the dialect is unknown", () => {
    expect(buildConnectionUrlCopy(config({ db_type: "mongodb", port: 27017 }), "jdbcUrl")).toBeNull();
    expect(connectionUrlCopyFormats(config({ db_type: "mongodb", port: 27017 }))).not.toContain("jdbcUrl");
  });

  it("uses the database override for JDBC URLs too", () => {
    expect(buildConnectionUrlCopy(config({}), "jdbcUrl", { database: "analytics" })).toBe("jdbc:postgresql://db.example.com:5432/analytics");
  });
});

describe("buildConnectionUrlCopy host:port, DSN and psql", () => {
  it("copies host:port", () => {
    expect(buildConnectionUrlCopy(config({}), "hostPort")).toBe("db.example.com:5432");
    expect(buildConnectionUrlCopy(config({ port: 0 }), "hostPort")).toBe("db.example.com");
  });

  it("builds a libpq key=value DSN without the password by default", () => {
    expect(buildConnectionUrlCopy(config({}), "dsn")).toBe("host=db.example.com port=5432 user=app_user dbname=appdb");
    expect(buildConnectionUrlCopy(config({ ssl: true }), "dsn")).toBe("host=db.example.com port=5432 user=app_user dbname=appdb sslmode=require");
  });

  it("embeds the password only in the explicit with-password DSN", () => {
    expect(buildConnectionUrlCopy(config({}), "dsnWithPassword")).toBe("host=db.example.com port=5432 user=app_user password=secret dbname=appdb");
    expect(buildConnectionUrlCopy(config({ password: "has space" }), "dsnWithPassword")).toContain("password='has space'");
    expect(buildConnectionUrlCopy(config({ password: "" }), "dsnWithPassword")).toBe(buildConnectionUrlCopy(config({ password: "" }), "dsn"));
  });

  it.each(["password", "pass%77ord", "sslpassword", "oauth_client_secret", "passcode", "apikey", "api_key", "access_token", "client_secret", "passphrase"])("redacts a %s supplied only through DSN parameters", (key) => {
    const postgres = config({ password: "", url_params: `application_name=svc&${key}=synthetic-secret&sslmode=require` });
    expect(buildConnectionUrlCopy(postgres, "dsn")).toBe(`host=db.example.com port=5432 user=app_user dbname=appdb application_name=svc ${key}=*** sslmode=require`);
    expect(buildConnectionUrlCopy(postgres, "dsnWithPassword")).toBe(`host=db.example.com port=5432 user=app_user dbname=appdb application_name=svc ${key}=synthetic-secret sslmode=require`);
    expect(connectionUrlCopyFormats(postgres)).toContain("dsnWithPassword");
  });

  it("redacts both stored and parameter passwords in the plain DSN", () => {
    const postgres = config({ url_params: "password=secondary-secret" });
    expect(buildConnectionUrlCopy(postgres, "dsn")).toBe("host=db.example.com port=5432 user=app_user dbname=appdb password=***");
    expect(buildConnectionUrlCopy(postgres, "dsnWithPassword")).toBe("host=db.example.com port=5432 user=app_user password=secret dbname=appdb password=secondary-secret");
  });

  it("builds a psql command without embedding the password", () => {
    expect(buildConnectionUrlCopy(config({}), "psqlCommand")).toBe("psql -h db.example.com -p 5432 -U app_user -d appdb");
    expect(buildConnectionUrlCopy(config({ database: undefined }), "psqlCommand", { database: "reporting" })).toBe("psql -h db.example.com -p 5432 -U app_user -d reporting");
  });

  it("restricts DSN and psql to the PostgreSQL wire family", () => {
    expect(connectionUrlCopyFormats(config({ db_type: "mysql", port: 3306 }))).not.toContain("dsn");
    expect(connectionUrlCopyFormats(config({ db_type: "mysql", port: 3306 }))).not.toContain("dsnWithPassword");
    expect(connectionUrlCopyFormats(config({ db_type: "mysql", port: 3306 }))).not.toContain("psqlCommand");
    expect(connectionUrlCopyFormats(config({ db_type: "redshift", port: 5439 }))).toContain("dsn");
    expect(connectionUrlCopyFormats(config({ db_type: "gaussdb", driver_profile: "gaussdb-m" }))).not.toContain("dsn");
    expect(buildConnectionUrlCopy(config({ db_type: "mysql", port: 3306 }), "dsn")).toBeNull();
    expect(buildConnectionUrlCopy(config({ db_type: "mysql", port: 3306 }), "dsnWithPassword")).toBeNull();
  });
});

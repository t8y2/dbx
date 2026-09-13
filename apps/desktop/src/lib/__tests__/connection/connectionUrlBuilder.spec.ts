import { describe, expect, it } from "vitest";
import { buildConnectionUrlCopy, CONNECTION_URL_COPY_WITH_PASSWORD_FORMATS, connectionSupportsUrlCopy, connectionUrlCopyFormats, type ConnectionUrlCopyConfig } from "@/lib/connection/connectionUrlBuilder";

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
});

describe("buildConnectionUrlCopy JDBC URL", () => {
  it("builds a generic PostgreSQL JDBC URL", () => {
    expect(buildConnectionUrlCopy(config({}), "jdbcUrl")).toBe("jdbc:postgresql://db.example.com:5432/appdb");
    expect(buildConnectionUrlCopy(config({}), "jdbcUrlWithCredentials")).toBe("jdbc:postgresql://db.example.com:5432/appdb?user=app_user&password=secret");
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
    expect(buildConnectionUrlCopy(config({ db_type: "gbase", port: 9088, driver_profile: "gbase8s" }), "jdbcUrl")).toBe("jdbc:gbasedbt-sqli://db.example.com:9088/appdb");
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

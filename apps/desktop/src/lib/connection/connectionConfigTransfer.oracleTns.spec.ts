import { describe, expect, it } from "vitest";
import { parseConnectionConfigObject, prepareConnectionConfigImport, scrubConnectionForPlaintextExport } from "./connectionConfigTransfer";
import { buildOracleTnsConnectionString, parseOracleTnsConnectionString } from "./oracleTnsConnection";

/**
 * An Oracle TNS connection stores its alias in `database` and the
 * `jdbc:oracle:thin:@<alias>?TNS_ADMIN=<dir>` string that resolves it in
 * `connection_string`. A plaintext export must keep that directory: without it
 * a re-imported connection cannot resolve the alias and has to be reconfigured
 * (issue #12672). Credentials still live in their own fields, so the alias and
 * the directory are safe to keep — nothing else is.
 */
describe("Oracle TNS plaintext exports", () => {
  const tnsAdmin = "C:\\oracle network\\admin";
  const tnsConnectionString = buildOracleTnsConnectionString("DBX_FAILOVER", tnsAdmin);

  function tnsConnection(overrides: Record<string, unknown> = {}) {
    return {
      id: "tns",
      name: "prod",
      db_type: "oracle" as const,
      host: "10.0.0.1",
      port: 1521,
      username: "scott",
      password: "tiger",
      database: "DBX_FAILOVER",
      oracle_connection_type: "tns" as const,
      driver_profile: "oracle",
      connection_string: tnsConnectionString,
      ...overrides,
    };
  }

  it("keeps the TNS_ADMIN directory that resolves the alias", () => {
    const exported = scrubConnectionForPlaintextExport(tnsConnection());

    expect(exported.connection_string).toBe(tnsConnectionString);
    expect(exported.database).toBe("DBX_FAILOVER");
    expect(parseOracleTnsConnectionString(exported.connection_string)).toEqual({ alias: "DBX_FAILOVER", tnsAdmin });
  });

  it("still removes the stored password", () => {
    const exported = scrubConnectionForPlaintextExport(tnsConnection());

    expect(exported.password).toBe("");
    expect(JSON.stringify(exported)).not.toContain("tiger");
  });

  it("re-imports a re-usable connection instead of an alias that cannot resolve", () => {
    const exported = scrubConnectionForPlaintextExport(tnsConnection());
    const parsed = parseConnectionConfigObject(JSON.parse(JSON.stringify({ connections: [exported] })));
    const imported = prepareConnectionConfigImport(parsed, [], [], () => "imported-id");

    expect(imported.connections[0]?.connection_string).toBe(tnsConnectionString);
    expect(parseOracleTnsConnectionString(imported.connections[0]?.connection_string)).toEqual({ alias: "DBX_FAILOVER", tnsAdmin });
  });

  it("keeps dropping every connection string that is not a TNS alias", () => {
    const exportedPostgres = scrubConnectionForPlaintextExport(tnsConnection({ db_type: "postgres", connection_string: "jdbc:postgresql://scott:tiger@host/db" }));
    const exportedUrl = scrubConnectionForPlaintextExport(tnsConnection({ connection_string: "postgres://scott:tiger@host/db" }));
    const exportedServiceName = scrubConnectionForPlaintextExport(tnsConnection({ oracle_connection_type: "service_name", connection_string: tnsConnectionString }));

    expect(exportedPostgres.connection_string).toBeUndefined();
    expect(exportedUrl.connection_string).toBeUndefined();
    expect(exportedServiceName.connection_string).toBeUndefined();
  });

  // The JDBC layer reads a query parameter as a credential when its *decoded*,
  // trimmed, lowercased name is `user` or `password`
  // (DbxJdbcPlugin.extractJdbcUrlCredentials). Matching raw names lets these through.
  it("drops every credential parameter, however its name is encoded", () => {
    const credentialStrings = [`${tnsConnectionString}&user=scott&password=tiger`, `${tnsConnectionString}&%70assword=tiger`, `${tnsConnectionString}&+password=tiger`, `${tnsConnectionString}&password%20=tiger`, `${tnsConnectionString}&%75ser=scott`];

    for (const connectionString of credentialStrings) {
      const exported = scrubConnectionForPlaintextExport(tnsConnection({ connection_string: connectionString }));

      expect(exported.connection_string).toBe(tnsConnectionString);
      expect(exported.connection_string).not.toContain("tiger");
      expect(exported.connection_string).not.toContain("scott");
    }
  });

  it("drops a TNS alias with no TNS_ADMIN directory to preserve", () => {
    const exported = scrubConnectionForPlaintextExport(tnsConnection({ connection_string: "jdbc:oracle:thin:@DBX_FAILOVER" }));

    expect(exported.connection_string).toBeUndefined();
    expect(exported.database).toBe("DBX_FAILOVER");
  });

  it("does not mutate the connection it was handed", () => {
    const source = tnsConnection({ connection_string: `${tnsConnectionString}&password=tiger` });
    scrubConnectionForPlaintextExport(source);

    expect(source.connection_string).toBe(`${tnsConnectionString}&password=tiger`);
    expect(source.password).toBe("tiger");
  });
});

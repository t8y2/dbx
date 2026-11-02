import { describe, expect, it } from "vitest";
import { savedMysqlTlsFormFields, supportsMysqlTlsOptions, supportsMysqlTlsTab } from "../mysqlTlsCapabilities";

describe("supportsMysqlTlsOptions", () => {
  it.each([
    ["doris", "doris"],
    ["starrocks", "starrocks"],
    ["mysql", "mysql"],
    ["mysql", "doris"],
    ["mysql", "starrocks"],
  ] as const)("makes the TLS tab and its MySQL controls reachable for %s/%s", (dbType, selectedType) => {
    expect(supportsMysqlTlsTab(dbType, selectedType)).toBe(true);
    expect(supportsMysqlTlsOptions(dbType, selectedType)).toBe(true);
  });

  it.each([
    ["mysql", "selectdb"],
    ["mysql", "oceanbase"],
  ] as const)("does not expand TLS support to %s/%s", (dbType, selectedType) => {
    expect(supportsMysqlTlsTab(dbType, selectedType)).toBe(false);
    expect(supportsMysqlTlsOptions(dbType, selectedType)).toBe(false);
  });

  it.each([
    ["native", "doris", "doris"],
    ["legacy", "mysql", "doris"],
  ] as const)("retains saved %s Doris TLS settings when the form reopens", (_kind, dbType, driverProfile) => {
    const fields = savedMysqlTlsFormFields({
      ssl: true,
      url_params: "ssl-mode=verify_identity&verify_ca=true&verify_identity=true&ssl-cert=/tmp/client.pem&ssl-key=/tmp/client-key.pem",
      ca_cert_path: "/tmp/doris-ca.pem",
      client_cert_path: "/tmp/legacy-client.pem",
      client_key_path: "/tmp/legacy-client-key.pem",
    });

    expect(supportsMysqlTlsTab(dbType, driverProfile)).toBe(true);
    expect(new URLSearchParams(fields.url_params).get("ssl-mode")).toBe("verify_identity");
    expect(fields).toEqual({
      ssl: true,
      url_params: "ssl-mode=verify_identity&verify_ca=true&verify_identity=true&ssl-cert=/tmp/client.pem&ssl-key=/tmp/client-key.pem",
      ca_cert_path: "/tmp/doris-ca.pem",
      client_cert_path: "/tmp/legacy-client.pem",
      client_key_path: "/tmp/legacy-client-key.pem",
    });
  });
});

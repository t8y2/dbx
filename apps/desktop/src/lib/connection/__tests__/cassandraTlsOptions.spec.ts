import { describe, expect, it } from "vitest";
import { buildCassandraExternalConfig, cassandraTlsConfigFromExternalConfig } from "../cassandraTlsOptions";

describe("Cassandra TLS options", () => {
  it("reads validated truststore and keystore fields", () => {
    expect(
      cassandraTlsConfigFromExternalConfig({
        tls: {
          truststore_path: "/certs/client.truststore",
          truststore_password: "trust-secret",
          keystore_path: "/certs/client.keystore",
          keystore_password: "key-secret",
          ignored: true,
        },
      }),
    ).toEqual({
      truststore_path: "/certs/client.truststore",
      truststore_password: "trust-secret",
      keystore_path: "/certs/client.keystore",
      keystore_password: "key-secret",
    });
  });

  it("ignores malformed external values", () => {
    expect(cassandraTlsConfigFromExternalConfig({ tls: { truststore_path: 42 } })).toEqual({
      truststore_path: "",
      truststore_password: "",
      keystore_path: "",
      keystore_password: "",
    });
  });

  it("trims paths without changing passwords", () => {
    expect(
      buildCassandraExternalConfig({
        truststore_path: "  /certs/client.p12  ",
        truststore_password: " trust-secret ",
        keystore_path: "  /certs/client.jks  ",
        keystore_password: " key-secret ",
      }),
    ).toEqual({
      tls: {
        truststore_path: "/certs/client.p12",
        truststore_password: " trust-secret ",
        keystore_path: "/certs/client.jks",
        keystore_password: " key-secret ",
      },
    });
  });

  it("omits empty TLS store configuration", () => {
    expect(
      buildCassandraExternalConfig({
        truststore_path: "",
        truststore_password: "",
        keystore_path: "",
        keystore_password: "",
      }),
    ).toBeUndefined();
  });
});

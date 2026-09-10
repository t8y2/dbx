export interface CassandraTlsConfig {
  truststore_path: string;
  truststore_password: string;
  keystore_path: string;
  keystore_password: string;
}

export interface CassandraExternalConfig {
  tls: CassandraTlsConfig;
}

function stringField(value: unknown, key: keyof CassandraTlsConfig): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

export function cassandraTlsConfigFromExternalConfig(value: unknown): CassandraTlsConfig {
  const tls = value && typeof value === "object" ? (value as Record<string, unknown>).tls : undefined;
  return {
    truststore_path: stringField(tls, "truststore_path"),
    truststore_password: stringField(tls, "truststore_password"),
    keystore_path: stringField(tls, "keystore_path"),
    keystore_password: stringField(tls, "keystore_password"),
  };
}

export function buildCassandraExternalConfig(tls: CassandraTlsConfig): CassandraExternalConfig | undefined {
  const truststorePath = tls.truststore_path.trim();
  const keystorePath = tls.keystore_path.trim();
  if (!truststorePath && !tls.truststore_password && !keystorePath && !tls.keystore_password) return undefined;
  return {
    tls: {
      truststore_path: truststorePath,
      truststore_password: tls.truststore_password,
      keystore_path: keystorePath,
      keystore_password: tls.keystore_password,
    },
  };
}

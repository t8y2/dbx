export interface KafkaTlsConfig {
  ca_cert_path: string;
  client_cert_path: string;
  client_key_path: string;
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

export function kafkaTlsFromExternalConfig(value: unknown): KafkaTlsConfig {
  const tls = value && typeof value === "object" ? (value as Record<string, unknown>).tls : undefined;
  return {
    ca_cert_path: stringField(tls, "ca_cert_path"),
    client_cert_path: stringField(tls, "client_cert_path"),
    client_key_path: stringField(tls, "client_key_path"),
  };
}

// 判别联合返回：dialog 层对 ok:false 抛错，ok:true 时 tls 可缺省。
export type KafkaTlsSectionResult = { ok: true; tls?: KafkaTlsConfig } | { ok: false; messageKey: string };

export function buildKafkaTlsSection(tls: KafkaTlsConfig, options: { clientCertEnabled: boolean }): KafkaTlsSectionResult {
  const caCertPath = tls.ca_cert_path.trim();
  const clientCertPath = tls.client_cert_path.trim();
  const clientKeyPath = tls.client_key_path.trim();

  // 开关关闭：cert/key 一律丢弃（表单值保留在 dialog reactive 态里，不受影响），仅 CA 生效。
  if (!options.clientCertEnabled) {
    if (!caCertPath) return { ok: true };
    return { ok: true, tls: { ca_cert_path: caCertPath, client_cert_path: "", client_key_path: "" } };
  }

  // 开关开启：cert/key 必须成对，否则硬拦截；提示语允许"同时留空"（等效单向 TLS）。
  if (!clientCertPath !== !clientKeyPath) {
    return { ok: false, messageKey: "connection.mqKafkaTlsClientCertPairRequired" };
  }
  if (!caCertPath && !clientCertPath) return { ok: true };
  return { ok: true, tls: { ca_cert_path: caCertPath, client_cert_path: clientCertPath, client_key_path: clientKeyPath } };
}

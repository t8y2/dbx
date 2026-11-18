import { describe, expect, it } from "vitest";
import { buildKafkaTlsSection, kafkaTlsFromExternalConfig } from "@/lib/connection/kafkaTlsOptions";

describe("kafkaTlsOptions", () => {
  it("reads snake_case PEM paths from the tls section", () => {
    expect(
      kafkaTlsFromExternalConfig({
        tls: { ca_cert_path: "/certs/ca-chain.pem", client_cert_path: "/certs/client.crt", client_key_path: "/certs/client.key" },
      }),
    ).toEqual({
      ca_cert_path: "/certs/ca-chain.pem",
      client_cert_path: "/certs/client.crt",
      client_key_path: "/certs/client.key",
    });
  });

  it("returns empty fields when the tls section is missing or malformed", () => {
    expect(kafkaTlsFromExternalConfig(undefined)).toEqual({ ca_cert_path: "", client_cert_path: "", client_key_path: "" });
    expect(kafkaTlsFromExternalConfig({})).toEqual({ ca_cert_path: "", client_cert_path: "", client_key_path: "" });
    expect(kafkaTlsFromExternalConfig({ tls: { ca_cert_path: 42 } })).toEqual({
      ca_cert_path: "",
      client_cert_path: "",
      client_key_path: "",
    });
  });

  // 开关关闭：cert/key 一律丢弃，仅 CA 生效；全空时不落 tls section。
  it("keeps only CA when the toggle is off, dropping residual client pair", () => {
    expect(buildKafkaTlsSection({ ca_cert_path: "", client_cert_path: "  ", client_key_path: "" }, { clientCertEnabled: false })).toEqual({ ok: true });
    expect(buildKafkaTlsSection({ ca_cert_path: " /certs/ca-chain.pem ", client_cert_path: "/certs/client.crt", client_key_path: " /certs/client.key " }, { clientCertEnabled: false })).toEqual({ ok: true, tls: { ca_cert_path: "/certs/ca-chain.pem", client_cert_path: "", client_key_path: "" } });
  });

  it("writes the trimmed trio when the toggle is on and the client pair is complete", () => {
    expect(buildKafkaTlsSection({ ca_cert_path: "", client_cert_path: " /certs/client.crt ", client_key_path: "/certs/client.key" }, { clientCertEnabled: true })).toEqual({ ok: true, tls: { ca_cert_path: "", client_cert_path: "/certs/client.crt", client_key_path: "/certs/client.key" } });
  });

  it("blocks a half-filled client pair when the toggle is on", () => {
    expect(buildKafkaTlsSection({ ca_cert_path: "/certs/ca-chain.pem", client_cert_path: "/certs/client.crt", client_key_path: "" }, { clientCertEnabled: true })).toEqual({ ok: false, messageKey: "connection.mqKafkaTlsClientCertPairRequired" });
    expect(buildKafkaTlsSection({ ca_cert_path: "", client_cert_path: "", client_key_path: "/certs/client.key" }, { clientCertEnabled: true })).toEqual({ ok: false, messageKey: "connection.mqKafkaTlsClientCertPairRequired" });
  });

  // 开关开 + cert/key 全空仍合法：错误文案写明"或同时留空"，等效单向 TLS。
  it("keeps CA only when the toggle is on but the client pair is empty", () => {
    expect(buildKafkaTlsSection({ ca_cert_path: "", client_cert_path: "", client_key_path: "" }, { clientCertEnabled: true })).toEqual({ ok: true });
    expect(buildKafkaTlsSection({ ca_cert_path: " /certs/ca-chain.pem ", client_cert_path: " ", client_key_path: "" }, { clientCertEnabled: true })).toEqual({ ok: true, tls: { ca_cert_path: "/certs/ca-chain.pem", client_cert_path: "", client_key_path: "" } });
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("NATS connection dialog", () => {
  it("offers NATS in the message-queue picker with the standard endpoint", () => {
    expect(dialogSource).toContain('nats: { type: "mq", port: 4222');
    expect(dialogSource).toContain('{ value: "nats", label: "NATS" }');
    expect(dialogSource).toContain('optionValues: ["mq", "kafka", "rocketmq", "rabbitmq", "nats", "mqtt"]');
    expect(dialogSource).toContain("serverUrl: NATS_DEFAULT_SERVER_URL");
  });

  it("serializes NATS credentials outside the URL and maps its TLS target", () => {
    expect(dialogSource).toContain("const target = natsConnectionTarget(mqNatsServerUrl.value);");
    expect(dialogSource).toContain("serverUrl: target.serverUrl");
    expect(dialogSource).toContain('username: requireMqField(mqBasicUsername.value, "NATS password auth requires a username")');
    expect(dialogSource).toContain('password: requireMqField(mqBasicPassword.value, "NATS password auth requires a password")');
    expect(dialogSource).toContain('token: requireMqField(mqToken.value, "NATS token auth requires a token")');
    expect(dialogSource).toContain("config.ssl = target.tls;");
  });
});

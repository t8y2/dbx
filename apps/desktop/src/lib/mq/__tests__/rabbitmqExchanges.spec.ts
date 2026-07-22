import { describe, expect, it } from "vitest";
import { defaultMqCapabilitiesForSystemKind } from "@/lib/mq/mqConsoleDefaults";
import { isBuiltinRabbitMqExchange, rabbitMqExchangeDisplayName, RABBITMQ_EXCHANGE_TYPES } from "@/lib/mq/rabbitmqExchanges";
import type { MqExchangeInfo } from "@/types/mq";

function exchange(partial: Partial<MqExchangeInfo>): MqExchangeInfo {
  return { name: "", type: "direct", durable: true, autoDelete: false, internal: false, ...partial };
}

describe("rabbitmqExchanges", () => {
  it("offers the four creatable exchange types", () => {
    expect(RABBITMQ_EXCHANGE_TYPES).toEqual(["direct", "fanout", "topic", "headers"]);
  });

  it("renders the default exchange with a display name", () => {
    expect(rabbitMqExchangeDisplayName(exchange({ name: "" }))).toBe("(AMQP default)");
    expect(rabbitMqExchangeDisplayName(exchange({ name: "dbx-events" }))).toBe("dbx-events");
    expect(rabbitMqExchangeDisplayName({ name: "amq.topic" })).toBe("amq.topic");
  });

  it("marks the default and amq.* exchanges as built-in", () => {
    expect(isBuiltinRabbitMqExchange(exchange({ name: "" }))).toBe(true);
    expect(isBuiltinRabbitMqExchange(exchange({ name: "amq.direct" }))).toBe(true);
    expect(isBuiltinRabbitMqExchange(exchange({ name: "amq.headers", type: "headers" }))).toBe(true);
    expect(isBuiltinRabbitMqExchange(exchange({ name: "dbx-internal", internal: true }))).toBe(true);
    expect(isBuiltinRabbitMqExchange(exchange({ name: "dbx-events" }))).toBe(false);
    expect(isBuiltinRabbitMqExchange(exchange({ name: "amqp.custom" }))).toBe(false);
  });
});

describe("mqConsoleDefaults RabbitMQ exchanges capability", () => {
  it("enables exchange management for RabbitMQ only", () => {
    expect(defaultMqCapabilitiesForSystemKind("rabbitmq").supportsExchanges).toBe(true);
    expect(defaultMqCapabilitiesForSystemKind("kafka").supportsExchanges).toBe(false);
    expect(defaultMqCapabilitiesForSystemKind("rocketmq").supportsExchanges).toBe(false);
    expect(defaultMqCapabilitiesForSystemKind("pulsar").supportsExchanges).toBeFalsy();
  });
});

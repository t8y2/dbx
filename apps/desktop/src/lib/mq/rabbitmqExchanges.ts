import type { MqExchangeInfo, MqExchangeType } from "@/types/mq";

/** Exchange types creatable through the RabbitMQ admin API. */
export const RABBITMQ_EXCHANGE_TYPES: MqExchangeType[] = ["direct", "fanout", "topic", "headers"];

/**
 * The default exchange has an empty name; display it as "(AMQP default)" in
 * the list, the same way the RabbitMQ management UI does.
 */
export function rabbitMqExchangeDisplayName(exchange: Pick<MqExchangeInfo, "name">): string {
  return exchange.name || "(AMQP default)";
}

/**
 * Built-in exchanges (the default exchange and the amq.* set) must not be
 * deleted from the console.
 */
export function isBuiltinRabbitMqExchange(exchange: MqExchangeInfo): boolean {
  return exchange.name === "" || exchange.name.startsWith("amq.") || exchange.internal;
}

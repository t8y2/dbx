const RABBITMQ_ADDRESS_SEPARATOR = /[\s,;，；]+/u;
const RABBITMQ_DEFAULT_PORT = "5672";
const RABBITMQ_PORT_PATTERN = /^\d+$/u;
const RABBITMQ_INVALID_HOST_CHARACTER = /[\s/?#@%\\\u200b-\u200d\ufeff]/u;

export interface RabbitmqAddress {
  host: string;
  port: number;
}

function requireRabbitmqAddresses(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("RabbitMQ addresses are required");
  return trimmed;
}

function invalidRabbitmqAddresses(): never {
  throw new Error("RabbitMQ addresses are invalid");
}

function validateRabbitmqPort(port: string): void {
  if (!RABBITMQ_PORT_PATTERN.test(port)) invalidRabbitmqAddresses();
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) invalidRabbitmqAddresses();
}

function validateRabbitmqHostname(host: string): void {
  if (!host || RABBITMQ_INVALID_HOST_CHARACTER.test(host)) invalidRabbitmqAddresses();
}

function validateRabbitmqIpv6(host: string): void {
  try {
    const parsed = new URL(`http://[${host}]`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== "/") {
      invalidRabbitmqAddresses();
    }
  } catch {
    invalidRabbitmqAddresses();
  }
}

export function parseRabbitmqAddress(address: string): RabbitmqAddress {
  if (address.includes("://")) {
    throw new Error("RabbitMQ addresses must be host:port values without a URL scheme");
  }

  if (address.startsWith("[")) {
    const match = address.match(/^\[([^\]]+)\](?::([^:]+))?$/u);
    if (!match) invalidRabbitmqAddresses();
    const [, host, port] = match;
    validateRabbitmqIpv6(host);
    if (port) {
      validateRabbitmqPort(port);
      return { host, port: Number(port) };
    }
    return { host, port: Number(RABBITMQ_DEFAULT_PORT) };
  }

  if (address.includes("[") || address.includes("]")) invalidRabbitmqAddresses();
  const separator = address.indexOf(":");
  if (separator !== address.lastIndexOf(":")) invalidRabbitmqAddresses();
  const host = separator >= 0 ? address.slice(0, separator) : address;
  const port = separator >= 0 ? address.slice(separator + 1) : "";
  if (!host || (separator >= 0 && !port)) invalidRabbitmqAddresses();
  validateRabbitmqHostname(host);
  if (port) {
    validateRabbitmqPort(port);
    return { host, port: Number(port) };
  }
  return { host, port: Number(RABBITMQ_DEFAULT_PORT) };
}

function normalizeRabbitmqAddress(address: string): string {
  const parsed = parseRabbitmqAddress(address);
  const hasExplicitPort = address.startsWith("[") ? address.includes("]:") : address.includes(":");
  return hasExplicitPort ? address : `${address}:${parsed.port}`;
}

export function normalizeRabbitmqAddresses(value: string): string {
  const addresses = requireRabbitmqAddresses(value)
    .split(RABBITMQ_ADDRESS_SEPARATOR)
    .map((address) => address.trim())
    .filter(Boolean)
    .map(normalizeRabbitmqAddress);
  if (!addresses.length) throw new Error("RabbitMQ addresses are required");
  return addresses.join(",");
}

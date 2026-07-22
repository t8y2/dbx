const RABBITMQ_ADDRESS_SEPARATOR = /[\s,;，；]+/u;
const RABBITMQ_DEFAULT_PORT = "5672";

function requireRabbitmqAddresses(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("RabbitMQ addresses are required");
  return trimmed;
}

function normalizeRabbitmqAddress(address: string): string {
  if (address.includes("://")) {
    throw new Error("RabbitMQ addresses must be host:port values without a URL scheme");
  }
  let parsed: URL;
  try {
    parsed = new URL(`amqp://${address}`);
  } catch {
    throw new Error("RabbitMQ addresses are invalid");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("RabbitMQ addresses are invalid");
  }
  return parsed.port ? address : `${address}:${RABBITMQ_DEFAULT_PORT}`;
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

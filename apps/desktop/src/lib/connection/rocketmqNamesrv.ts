const ROCKETMQ_NAMESRV_SEPARATOR = /[\s,;，；]+/u;

function requireRocketmqNamesrv(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("RocketMQ NameServer address is required");
  return trimmed;
}

function normalizeRocketmqNamesrvServer(server: string): string {
  if (server.includes("://")) {
    throw new Error("RocketMQ NameServer addresses must be host:port values without a URL scheme");
  }
  let parsed: URL;
  try {
    parsed = new URL(`rocketmq://${server}`);
  } catch {
    throw new Error("RocketMQ NameServer addresses are invalid");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("RocketMQ NameServer addresses are invalid");
  }
  return server;
}

export function normalizeRocketmqNamesrvAddr(value: string): string {
  const servers = requireRocketmqNamesrv(value)
    .split(ROCKETMQ_NAMESRV_SEPARATOR)
    .map((server) => server.trim())
    .filter(Boolean)
    .map(normalizeRocketmqNamesrvServer);
  if (!servers.length) throw new Error("RocketMQ NameServer address is required");
  return servers.join(";");
}

const CONNECTION_ERROR_PATTERNS = [
  "connection reset",
  "connection refused",
  "connection timed out",
  "connection closed",
  "connection lost",
  "connection not found",
  "connection config not found",
  "not connected",
  "closed the connection",
  "broken pipe",
  "reset by peer",
  "socket closed",
  "unexpected eof",
  "end-of-file",
  "end-of-file on communication channel",
  "server closed session",
  "communicating with the server",
  "exceeded maximum idle time",
  "agent stdin not available",
  "agent stdout not available",
  "failed to write to agent stdin",
  "failed to flush agent stdin",
  "input/output error",
  "关闭的连接",
  "连接已关闭",
  "i/o error",
  "no route to host",
];

export function staleConnectionMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function shouldMarkDisconnected(error: unknown): boolean {
  const message = staleConnectionMessage(error).toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => message.includes(pattern)) || hasConnectionOsError(message);
}

function hasConnectionOsError(message: string): boolean {
  const osErrorCodes = new Set(["65", "10053", "10054", "10057", "10058", "10060", "10061"]);
  const match = message.match(/os error\s+(\d+)/);
  return !!match && osErrorCodes.has(match[1]);
}

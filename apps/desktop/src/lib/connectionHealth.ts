const CONNECTION_ERROR_PATTERNS = ["connection", "broken pipe", "reset by peer", "timed out", "closed", "eof", "i/o error"];

export function staleConnectionMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function shouldMarkDisconnected(error: unknown): boolean {
  const message = staleConnectionMessage(error).toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => message.includes(pattern)) || hasConnectionOsError(message);
}

function hasConnectionOsError(message: string): boolean {
  const osErrorCodes = new Set(["10053", "10054", "10057", "10058", "10060", "10061"]);
  const match = message.match(/os error\s+(\d+)/);
  return !!match && osErrorCodes.has(match[1]);
}

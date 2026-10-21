export interface SqlServerHostPortResult {
  host: string;
  port?: number;
  portExplicit: boolean;
}

export function parseSqlServerHostPort(rawHost: string, currentPort?: number): SqlServerHostPortResult {
  let host = (rawHost ?? "").trim();
  if (!host) {
    return { host: "", port: currentPort, portExplicit: false };
  }

  // Strip case-insensitive tcp: prefix
  if (host.toLowerCase().startsWith("tcp:")) {
    host = host.slice(4).trim();
  }

  // Bracketed IPv6: [fe80::1],9005 or [::1]:9005 or [::1]
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close !== -1) {
      const bracketed = host.slice(0, close + 1);
      const remainder = host.slice(close + 1).trim();
      if (remainder.startsWith(",") || remainder.startsWith(":")) {
        const portStr = remainder.slice(1).trim();
        const parsed = Number(portStr);
        if (/^[0-9]+$/.test(portStr) && Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
          return { host: bracketed, port: parsed, portExplicit: true };
        }
      }
      return { host: remainder ? host : bracketed, port: currentPort, portExplicit: false };
    }
  }

  // Comma-separated port: host,port or host\instance,port
  const commaIdx = host.lastIndexOf(",");
  if (commaIdx !== -1) {
    const candidateHost = host.slice(0, commaIdx).trim();
    const portStr = host.slice(commaIdx + 1).trim();
    const parsed = Number(portStr);
    if (/^[0-9]+$/.test(portStr) && Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return { host: candidateHost, port: parsed, portExplicit: true };
    }
  }

  // Colon-separated port: host:port (single colon only to avoid unbracketed IPv6)
  const colonCount = (host.match(/:/g) || []).length;
  if (colonCount === 1) {
    const colonIdx = host.lastIndexOf(":");
    const candidateHost = host.slice(0, colonIdx).trim();
    const portStr = host.slice(colonIdx + 1).trim();
    const parsed = Number(portStr);
    if (/^[0-9]+$/.test(portStr) && Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return { host: candidateHost, port: parsed, portExplicit: true };
    }
  }

  return { host, port: currentPort, portExplicit: false };
}

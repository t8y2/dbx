export type CosmosDbEndpointInput = {
  host: string;
  port: number;
  ssl: boolean;
  /** Account key, when the input was a portal connection string. */
  accountKey?: string;
};

const DEFAULT_COSMOS_DB_PORT = 443;

/**
 * Interprets what a user typed or pasted into the Cosmos DB endpoint field:
 * a bare host, an account URI (`https://acct.documents.azure.com:443/`), or a
 * portal connection string (`AccountEndpoint=...;AccountKey=...;`).
 * Returns `null` when the text is not recognizable.
 */
export function parseCosmosDbEndpointInput(input: string): CosmosDbEndpointInput | null {
  const value = input.trim();
  if (!value) return null;

  let endpoint = value;
  let accountKey: string | undefined;
  if (/accountendpoint\s*=/i.test(value)) {
    const parts = new Map<string, string>();
    for (const part of value.split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      // Base64 keys end with "=" padding, so only the first "=" separates the name.
      parts.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
    }
    const parsedEndpoint = parts.get("accountendpoint");
    if (!parsedEndpoint) return null;
    endpoint = parsedEndpoint;
    accountKey = parts.get("accountkey") || undefined;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  // DNS names and IPv4 addresses, or IPv6 literals (which contain ":").
  if (!host || (!/^[A-Za-z0-9.-]+$/.test(host) && !host.includes(":"))) return null;
  const ssl = url.protocol === "https:";
  const port = url.port ? Number(url.port) : ssl ? DEFAULT_COSMOS_DB_PORT : 80;
  return { host, port, ssl, ...(accountKey ? { accountKey } : {}) };
}

export type ZooKeeperAuthScheme = "digest" | "sasl_digest";

const AUTH_SCHEME_PARAM = "auth_scheme";

function parseParams(params?: string): URLSearchParams {
  return new URLSearchParams((params || "").trim().replace(/^\?/, "").replace(/;/g, "&"));
}

function isAuthSchemeParam(key: string): boolean {
  return key.trim().toLowerCase() === AUTH_SCHEME_PARAM;
}

export function zooKeeperAuthScheme(params?: string): ZooKeeperAuthScheme {
  const configured = Array.from(parseParams(params).entries()).find(([key]) => isAuthSchemeParam(key))?.[1];
  return configured?.toLowerCase() === "sasl_digest" ? "sasl_digest" : "digest";
}

export function setZooKeeperAuthScheme(params: string | undefined, scheme: ZooKeeperAuthScheme): string {
  const parsed = parseParams(params);
  for (const key of Array.from(parsed.keys())) {
    if (isAuthSchemeParam(key)) parsed.delete(key);
  }
  if (scheme === "sasl_digest") parsed.set(AUTH_SCHEME_PARAM, scheme);
  return parsed.toString();
}

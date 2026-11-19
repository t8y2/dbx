export function mongoUrlParam(urlParams: string | undefined, key: string): string {
  const params = parseMongoUrlParams(urlParams);
  return params.get(key) || "";
}

export function mongoConnectionUsesOidc(urlParams: string | undefined, connectionString?: string): boolean {
  const input = connectionString?.trim() || "";
  if (input) {
    if (!/^mongodb(?:\+srv)?:\/\//i.test(input)) return false;
    const queryStart = input.indexOf("?");
    if (queryStart < 0) return false;
    const fragmentStart = input.indexOf("#", queryStart + 1);
    const query = input.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
    return mongoUrlParamCaseInsensitive(query, "authMechanism").toUpperCase() === "MONGODB-OIDC";
  }

  return mongoUrlParamCaseInsensitive(urlParams, "authMechanism").toUpperCase() === "MONGODB-OIDC";
}

export function setMongoUrlParam(urlParams: string | undefined, key: string, value: string): string {
  const params = parseMongoUrlParams(urlParams);
  const normalized = value.trim();
  if (normalized) {
    params.set(key, normalized);
  } else {
    params.delete(key);
  }
  return params.toString();
}

export function mongoUrlParamIsTrue(urlParams: string | undefined, key: string, defaultValue = false): boolean {
  const value = mongoUrlParam(urlParams, key);
  if (!value) return defaultValue;
  return ["true", "1", "yes"].includes(value.toLowerCase());
}

export function setMongoUrlParamBoolean(urlParams: string | undefined, key: string, value: boolean, defaultWhenEnabled = false): string {
  if (value === defaultWhenEnabled) {
    return setMongoUrlParam(urlParams, key, "");
  }
  return setMongoUrlParam(urlParams, key, value ? "true" : "false");
}

export function normalizeMongoTlsFormState(ssl: boolean, urlParams: string | undefined, caCertPath: string | undefined): { urlParams: string; caCertPath: string } {
  if (ssl) {
    const nextCaCertPath = caCertPath?.trim() || "";
    let nextUrlParams = urlParams || "";
    if (nextCaCertPath) {
      nextUrlParams = setMongoUrlParam(nextUrlParams, "tlsCAFile", "");
    }
    return { urlParams: nextUrlParams, caCertPath: nextCaCertPath };
  }
  const next = setMongoUrlParam(setMongoUrlParam(setMongoUrlParam(urlParams, "tlsAllowInvalidCertificates", ""), "tlsAllowInvalidHostnames", ""), "tlsCAFile", "");
  return { urlParams: next, caCertPath: "" };
}

/**
 * MongoDB Atlas cluster names (`cluster0.abcde.mongodb.net`) exist only as SRV
 * records, so a plain `host:port` connection to them fails DNS lookup. Atlas's
 * per-member hostnames (`…-shard-00-00.abcde.mongodb.net`) resolve normally.
 */
export function looksLikeMongoSrvHost(host: string | undefined): boolean {
  const normalized = host?.trim().toLowerCase() ?? "";
  return /^[a-z0-9-]+\.[a-z0-9-]+\.mongodb\.net\.?$/.test(normalized) && !normalized.includes("-shard-");
}

/** The form-mode fields as a `mongodb+srv://` URL; SRV carries no port and turns TLS on by default. */
export function mongoSrvConnectionString(form: { host: string; username?: string; password?: string; database?: string; url_params?: string; ca_cert_path?: string }): string {
  const params = parseMongoUrlParams(form.url_params);
  // SRV discovers the members itself, and DBX's TLS defaults already come from the SRV scheme.
  const droppedKeys = Array.from(params.keys()).filter((key) => ["directconnection", "tls", "ssl"].includes(key.toLowerCase()));
  for (const key of droppedKeys) params.delete(key);
  const caCertPath = form.ca_cert_path?.trim();
  if (caCertPath && !params.has("tlsCAFile")) params.set("tlsCAFile", caCertPath);

  const username = form.username?.trim() ?? "";
  const usesOidc = mongoUrlParamCaseInsensitive(params.toString(), "authMechanism").toUpperCase() === "MONGODB-OIDC";
  const userInfo = username ? `${encodeURIComponent(username)}${usesOidc ? "" : `:${encodeURIComponent(form.password ?? "")}`}@` : "";
  const host = form.host.trim().replace(/:\d+$/, "");
  const database = form.database?.trim();
  const query = params.toString();
  return `mongodb+srv://${userInfo}${host}/${database ? encodeURIComponent(database) : ""}${query ? `?${query}` : ""}`;
}

export function mongodbAuthFailureHint(message: string): string {
  const normalizedMessage = message.toLowerCase();
  if (normalizedMessage.includes("tlsallowinvalidhostnames is an invalid option")) {
    return `${message}\n\nDBX uses the Rust MongoDB driver (rustls), which does not accept tlsAllowInvalidHostnames in the connection string. Use tlsAllowInvalidCertificates=true instead. This is commonly required for AWS DocumentDB over an SSH tunnel because the local endpoint is 127.0.0.1 while the server certificate is issued for the DocumentDB hostname.`;
  }

  if (message.includes('certificate not valid for name "127.0.0.1"') || (message.includes("invalid peer certificate") && message.includes("127.0.0.1") && message.includes("docdb"))) {
    return `${message}\n\nTLS hostname verification failed because the SSH tunnel connects to 127.0.0.1, but the DocumentDB certificate is issued for the cluster hostname. Add tlsAllowInvalidCertificates=true to URL params. Keep tlsCAFile configured so the certificate chain is still trusted when possible.`;
  }

  if (message.includes("cannot specify multiple seeds with directConnection=true")) {
    return `${message}\n\nMongoDB directConnection=true can only be used with a single host. Remove directConnection=true when using a multi-host replica set URL, or keep only one reachable host if you need a direct connection.`;
  }

  if (message.includes("no records found") && message.includes("_mongodb._tcp.")) {
    return `${message}\n\nMongoDB SRV URLs require a DNS hostname with SRV records. For an IP address or normal host:port endpoint, use mongodb://host:port instead of mongodb+srv://host.`;
  }

  const unresolvedHost = mongoUnresolvedHost(message);
  if (unresolvedHost && looksLikeMongoSrvHost(unresolvedHost)) {
    return `${message}\n\n${unresolvedHost} looks like a MongoDB Atlas cluster name, which only has SRV DNS records. Switch to URL mode and connect with mongodb+srv://${unresolvedHost} instead of host:port.`;
  }

  if (message.includes("ReplicaSetNoPrimary") && message.includes("127.0.0.1:27017")) {
    return `${message}\n\nThe replica set is advertising 127.0.0.1:27017, which points back to this app machine instead of the MongoDB server. Add directConnection=true for a single reachable endpoint, or reconfigure the replica set members to advertise addresses reachable from this app.`;
  }

  if (message.includes("must be URL encoded") || message.includes("cannot contain unescaped %")) {
    return `${message}\n\nMongoDB URL mode requires reserved characters in usernames and passwords to be percent-encoded. For example, @ becomes %40, # becomes %23, / becomes %2F, : becomes %3A, and % becomes %25.`;
  }

  if (message.includes("not authorized") && message.includes("listDatabases")) {
    return `${message}\n\nThis MongoDB user can authenticate but does not have permission to run listDatabases on admin. Grant listDatabases/cluster monitor privileges, or set a specific default database that the user can access.`;
  }

  if (message.includes("Current authentication database:")) return message;

  const source = message.match(/source='([^']+)'/)?.[1];
  if (!source || !message.includes("Exception authenticating MongoCredential")) return message;

  const verificationHint = `Current authentication database: ${source}. The server rejected these credentials. Verify the username and password, and confirm that the user was created in ${source}.`;
  if (source.toLowerCase() === "admin") return `${message}\n\n${verificationHint}`;

  return `${message}\n\n${verificationHint} If the user was created in admin, set Authentication database to admin or add authSource=admin to URL params.`;
}

/** The host of a server-selection failure whose DNS lookup failed, as the driver reports it on each OS. */
function mongoUnresolvedHost(message: string): string | null {
  const lookupFailed = /os error 11001|no such host is known|failed to lookup address|nodename nor servname|name or service not known|不知道这样的主机/i.test(message);
  if (!lookupFailed) return null;
  return /Address:\s*([^\s,:]+):\d+/.exec(message)?.[1] ?? null;
}

function parseMongoUrlParams(urlParams: string | undefined): URLSearchParams {
  return new URLSearchParams((urlParams || "").trim().replace(/^\?/, ""));
}

function mongoUrlParamCaseInsensitive(urlParams: string | undefined, key: string): string {
  const expectedKey = key.toLowerCase();
  for (const [paramKey, value] of parseMongoUrlParams(urlParams)) {
    if (paramKey.toLowerCase() === expectedKey) return value;
  }
  return "";
}

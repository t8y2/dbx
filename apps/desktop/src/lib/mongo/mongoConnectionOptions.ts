export function mongoUrlParam(urlParams: string | undefined, key: string): string {
  const params = parseMongoUrlParams(urlParams);
  return params.get(key) || "";
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

  return `${message}\n\nCurrent authentication database: ${source}. If this user was created in admin, set Authentication database to admin or add authSource=admin to URL params.`;
}

function parseMongoUrlParams(urlParams: string | undefined): URLSearchParams {
  return new URLSearchParams((urlParams || "").trim().replace(/^\?/, ""));
}

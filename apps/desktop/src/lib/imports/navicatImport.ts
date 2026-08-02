import type { ConnectionConfig, DatabaseType, SshTunnelConfig } from "@/types/database";
import { uuid } from "@/lib/common/utils";

type PartialConnection = Omit<ConnectionConfig, "id">;

type MongoReplicaMember = { host: string; port: number };

type ParsedNode = {
  tag: string;
  values: Record<string, string>;
  members: MongoReplicaMember[];
};

const typeMap: Record<string, { dbType: DatabaseType; profile: string; label: string; port: number; user: string }> = {
  // String type identifiers (from Navicat ConnType / DatabaseType attributes)
  mysql: { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  mariadb: { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  postgresql: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  postgres: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  sqlite: { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  sqlserver: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  mssql: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  oracle: { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  redis: { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
  mongodb: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  mongo: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  dameng: { dbType: "dameng", profile: "dm", label: "达梦 Dameng", port: 5236, user: "SYSDBA" },
  dm: { dbType: "dameng", profile: "dm", label: "达梦 Dameng", port: 5236, user: "SYSDBA" },
  clickhouse: { dbType: "clickhouse", profile: "clickhouse", label: "ClickHouse", port: 8123, user: "default" },
  snowflake: { dbType: "snowflake", profile: "snowflake", label: "Snowflake", port: 443, user: "" },
  kingbase: { dbType: "kingbase", profile: "kingbase", label: "KingbaseES", port: 54321, user: "SYSTEM" },
  kingbasees: { dbType: "kingbase", profile: "kingbase", label: "KingbaseES", port: 54321, user: "SYSTEM" },
  gaussdb: { dbType: "gaussdb", profile: "gaussdb", label: "GaussDB", port: 8000, user: "root" },
  oceanbase: { dbType: "oceanbase-oracle", profile: "oceanbase", label: "OceanBase", port: 2883, user: "root" },
  // Numeric type codes (Navicat uses numeric ConnType for some exports)
  "1": { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  "2": { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  "3": { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  "4": { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  "5": { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  "7": { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  "8": { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  "9": { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
};

const unsupportedTypes = new Set(["http", "https", "ftp", "sftp", "ssh"]);
let navicatCipherModule: Promise<typeof import("@noble/ciphers/aes.js")> | undefined;

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getAny(values: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = values[normalizeKey(key)];
    if (value?.trim()) return value.trim();
  }
  return "";
}

function getSqlitePath(values: Record<string, string>) {
  return getAny(values, ["databaseFile", "databaseFileName", "databaseFilename", "filename", "fileName", "path", "databasePath", "dbPath", "dbFile", "sqliteFile", "sqlitePath", "database", "databaseName"]);
}

function truthyNavicatFlag(value: string) {
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on", "checked"].includes(normalized);
}

function optionalNavicatFlag(value: string): boolean | undefined {
  return value.trim() ? truthyNavicatFlag(value) : undefined;
}

function hexToBytes(hex: string) {
  const clean = hex.trim();
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

function stripPkcs7(bytes: Uint8Array) {
  const pad = bytes[bytes.length - 1];
  if (!pad || pad > 16 || pad > bytes.length) return bytes;
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) return bytes;
  }
  return bytes.slice(0, bytes.length - pad);
}

async function decryptNavicatPassword(value: string) {
  const encrypted = hexToBytes(value);
  if (!encrypted?.length) return "";

  const key = new TextEncoder().encode("libcckeylibcckey");
  const iv = new TextEncoder().encode("libcciv libcciv ");
  try {
    const subtle = globalThis.crypto?.subtle;
    const decrypted = subtle ? await decryptNavicatPasswordWithWebCrypto(subtle, encrypted, key, iv) : await decryptNavicatPasswordWithoutWebCrypto(encrypted, key, iv);
    return new TextDecoder().decode(stripPkcs7(decrypted));
  } catch {
    return "";
  }
}

async function decryptNavicatPasswordWithWebCrypto(subtle: SubtleCrypto, encrypted: Uint8Array<ArrayBuffer>, key: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>) {
  const cryptoKey = await subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, encrypted));
}

async function decryptNavicatPasswordWithoutWebCrypto(encrypted: Uint8Array<ArrayBuffer>, key: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>) {
  const { cbc } = await (navicatCipherModule ??= import("@noble/ciphers/aes.js"));
  return cbc(key, iv).decrypt(encrypted);
}

function parseNavicatPort(value: string, fallback: number) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

async function parseSshTunnel(values: Record<string, string>): Promise<({ type: "ssh" } & SshTunnelConfig) | null> {
  const enabled = getAny(values, ["ssh", "useSsh", "sshEnabled", "enableSsh", "useSshTunnel", "sshTunnelEnabled"]);
  if (!truthyNavicatFlag(enabled)) return null;

  const host = getAny(values, ["sshHost", "sshTunnelHost", "tunnelHost"]);
  const user = getAny(values, ["sshUserName", "sshUsername", "sshUser", "sshTunnelUserName", "sshTunnelUsername", "tunnelUserName"]);
  // A half-populated tunnel makes an otherwise valid imported connection unusable.
  if (!host || !user) return null;

  const authValue = normalizeKey(getAny(values, ["sshAuthenMethod", "sshAuthMethod", "sshAuthenticationMethod", "sshAuthentication", "sshAuthType"]));
  const keyPath = getAny(values, ["sshPrivateKey", "sshKeyFile", "sshKeyPath", "sshIdentityFile", "sshTunnelPrivateKey"]);
  const usesKey = authValue.includes("key") || (!authValue.includes("password") && !!keyPath);
  const password = usesKey ? "" : await decryptNavicatPassword(getAny(values, ["sshPassword", "sshTunnelPassword"]));
  const keyPassphrase = usesKey ? await decryptNavicatPassword(getAny(values, ["sshPassphrase", "sshKeyPassphrase", "sshPrivateKeyPassphrase"])) : "";

  return {
    type: "ssh",
    id: uuid(),
    enabled: true,
    host,
    port: parseNavicatPort(getAny(values, ["sshPort", "sshTunnelPort", "tunnelPort"]), 22),
    user,
    password,
    key_path: usesKey ? keyPath : "",
    key_passphrase: keyPassphrase,
    auth_method: usesKey ? "key" : "password",
  };
}

function inferProfile(rawType: string, tag: string, port?: number) {
  const key = normalizeKey(rawType || tag);
  for (const [needle, profile] of Object.entries(typeMap)) {
    if (key.includes(needle)) return profile;
  }
  if (unsupportedTypes.has(key)) return null;
  // Port-based fallback for common default ports
  if (port) {
    if (port === 6379) return typeMap.redis;
    if (port === 27017) return typeMap.mongodb;
    if (port === 5432) return typeMap.postgresql;
    if (port === 3306) return typeMap.mysql;
    if (port === 1433) return typeMap.sqlserver;
    if (port === 1521) return typeMap.oracle;
  }
  return null;
}

function readNode(element: Element): ParsedNode {
  const values: Record<string, string> = {};
  const members: MongoReplicaMember[] = [];
  for (const attr of Array.from(element.attributes)) {
    values[normalizeKey(attr.name)] = attr.value;
  }

  for (const child of Array.from(element.children)) {
    const childTag = normalizeKey(child.tagName);
    if (childTag === "member") {
      const childValues = valuesFromElement(child);
      const memberHost = getAny(childValues, ["hostname", "host", "address"]);
      if (memberHost) {
        members.push({ host: memberHost, port: parseNavicatPort(getAny(childValues, ["port"]), 27017) });
      }
      // Skip flattening so multiple members don't collapse onto one key.
      continue;
    }

    const key = getAny(valuesFromElement(child), ["name", "key", "property", "field"]);
    const value = getAny(valuesFromElement(child), ["value", "val", "text", "data"]) || child.textContent?.trim() || "";
    if (key && value) values[normalizeKey(key)] = value;

    const tag = normalizeKey(child.tagName);
    const text = child.children.length === 0 ? child.textContent?.trim() || "" : "";
    if (text && !values[tag]) values[tag] = text;
    for (const attr of Array.from(child.attributes)) {
      values[`${tag}${normalizeKey(attr.name)}`] = attr.value;
    }
  }

  return { tag: element.tagName, values, members };
}

function valuesFromElement(element: Element) {
  const values: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    values[normalizeKey(attr.name)] = attr.value;
  }
  return values;
}

function isConnectionCandidate(node: ParsedNode) {
  // <Member>/<Advance> are nested metadata, not standalone connections.
  if (["member", "advance"].includes(normalizeKey(node.tag))) return false;
  const type = getAny(node.values, ["connType", "databaseType", "driver", "connectionType", "type"]);
  const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]);
  const host = getAny(node.values, ["host", "server", "hostname", "serverHost", "address"]);
  const file = getSqlitePath(node.values);
  return !!(name || host || file) && !!(type || host || file);
}

function encodeMongoUrlPart(value: string): string {
  return encodeURIComponent(value);
}

function normalizeMongoAuthMechanism(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  // "Password" is the SCRAM default; let the driver negotiate it.
  if (/^(password|default|none|scram)$/i.test(trimmed)) return "";
  return trimmed.toUpperCase();
}

function normalizeMongoReadPreference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^primary$/i.test(trimmed)) return "";
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function buildMongoReplicaSetConnectionString(opts: {
  useSrv: boolean;
  username: string;
  password: string;
  members: MongoReplicaMember[];
  database: string;
  replicaSet: string;
  authSource: string;
  authMechanism: string;
  readPreference: string;
  retryReads?: boolean;
  retryWrites?: boolean;
  ssl: boolean;
}): string {
  const scheme = opts.useSrv ? "mongodb+srv://" : "mongodb://";
  const userInfo = opts.username ? `${encodeMongoUrlPart(opts.username)}:${encodeMongoUrlPart(opts.password)}@` : "";

  let hosts: string;
  if (opts.useSrv) {
    // SRV forbids ports; DNS resolves the seed list.
    const srvHost = opts.members[0]?.host ?? "";
    hosts = encodeMongoUrlPart(srvHost);
  } else {
    hosts = opts.members.map((member) => (member.host.includes(":") ? `[${member.host}]:${member.port}` : `${member.host}:${member.port}`)).join(",");
  }

  const path = opts.database ? `/${encodeMongoUrlPart(opts.database)}` : "";
  const params = new URLSearchParams();
  if (opts.replicaSet) params.set("replicaSet", opts.replicaSet);
  if (opts.authSource) params.set("authSource", opts.authSource);
  const authMechanism = normalizeMongoAuthMechanism(opts.authMechanism);
  if (authMechanism) params.set("authMechanism", authMechanism);
  const readPreference = normalizeMongoReadPreference(opts.readPreference);
  if (readPreference) params.set("readPreference", readPreference);
  if (opts.retryWrites !== undefined) params.set("retryWrites", String(opts.retryWrites));
  if (opts.retryReads !== undefined) params.set("retryReads", String(opts.retryReads));
  if (opts.ssl) params.set("tls", "true");
  const query = params.toString();

  return `${scheme}${userInfo}${hosts}${path}${query ? `?${query}` : ""}`;
}

async function parseConnection(node: ParsedNode): Promise<ConnectionConfig | null> {
  const rawType = getAny(node.values, ["connType", "databaseType", "driver", "dbType", "connectionType", "type"]);
  const portValue = Number(getAny(node.values, ["port", "serverPort"]));
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : undefined;
  const profile = inferProfile(rawType, node.tag, port);
  if (!profile) {
    const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]) || "(unnamed)";
    console.warn(`[Navicat Import] Skipped connection with unrecognised type: "${name}" (type="${rawType}", tag="${node.tag}", port=${port ?? "N/A"})`);
    return null;
  }

  // Navicat NCX uses ServiceProvider to distinguish vendor-specific database providers.
  // e.g. OceanBase MySQL reports ConnType="MYSQL" ServiceProvider="AliyunOceanBase"
  //      OceanBase Oracle reports ConnType="ORACLE" ServiceProvider="AliyunOceanBase"
  //      GaussDB reports ConnType="POSTGRESQL" ServiceProvider="HuaweiCloudGaussDB"
  // For OceanBase, ConnType remains the source of truth for the compatibility mode.
  const serviceProvider = getAny(node.values, ["serviceprovider"]);
  let effectiveProfile = profile;
  if (serviceProvider) {
    const sp = serviceProvider.toLowerCase();
    if (sp.includes("oceanbase")) {
      const oceanbaseOracleMode = normalizeKey(rawType).includes("oracle") || profile.dbType === "oracle";
      effectiveProfile = oceanbaseOracleMode ? { ...profile, dbType: "oceanbase-oracle", profile: "oceanbase-oracle", label: "OceanBase Oracle Mode", port: 2883 } : { ...profile, dbType: "mysql", profile: "oceanbase", label: "OceanBase", port: 2883 };
    } else if (sp.includes("gaussdb") || sp.includes("huaweicloudgauss")) {
      effectiveProfile = { ...profile, dbType: "gaussdb", profile: "gaussdb", label: "GaussDB", port: 8000 };
    }
  }

  const sqlitePath = effectiveProfile.dbType === "sqlite" ? getSqlitePath(node.values) : "";
  const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]) || getAny(node.values, ["host", "server", "hostname"]) || sqlitePath || effectiveProfile.label;
  const host = sqlitePath || getAny(node.values, ["host", "server", "hostname", "serverHost", "address"]) || (effectiveProfile.dbType === "sqlite" ? "" : "127.0.0.1");
  // Navicat exports OceanBase Oracle connections with Database="ORCL", but OceanBase resolves the target from the username.
  const database = effectiveProfile.dbType === "sqlite" ? "" : effectiveProfile.dbType === "oceanbase-oracle" ? "" : getAny(node.values, ["database", "databaseName", "initialDatabase", "serviceName", "sid", "schema"]);
  const isOracleLike = effectiveProfile.dbType === "oracle" || effectiveProfile.dbType === "oceanbase-oracle";
  const oracleConnectionType = isOracleLike && getAny(node.values, ["sid"]) ? "sid" : isOracleLike ? "service_name" : undefined;
  const username = getAny(node.values, ["user", "username", "userName", "uid"]) || profile.user;
  const password = await decryptNavicatPassword(getAny(node.values, ["password"]));
  const keepaliveValue = Number(getAny(node.values, ["keepAliveInterval", "keepaliveInterval", "keepAliveTime", "keepaliveTime"]));
  const keepaliveFlag = getAny(node.values, ["keepAlive", "keepalive", "useKeepAlive", "enableKeepAlive"]);
  const keepaliveEnabled = !keepaliveFlag || truthyNavicatFlag(keepaliveFlag);
  const keepaliveInterval = Number.isFinite(keepaliveValue) && keepaliveValue > 0 && keepaliveEnabled ? keepaliveValue : 0;
  const sshTunnel = await parseSshTunnel(node.values);

  const config: PartialConnection = {
    name,
    db_type: effectiveProfile.dbType,
    driver_profile: effectiveProfile.profile,
    driver_label: effectiveProfile.label,
    url_params: "",
    host,
    port: port || effectiveProfile.port,
    username,
    password,
    database: database || undefined,
    color: "",
    transport_layers: sshTunnel ? [sshTunnel] : [],
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
    keepalive_interval_secs: keepaliveInterval,
    ssl: false,
    oracle_connection_type: oracleConnectionType,
    connection_string: undefined,
    jdbc_driver_class: undefined,
    jdbc_driver_paths: [],
  };

  // Navicat leaves <Connection Host> as a "localhost" placeholder; rebuild a
  // multi-host URL from the real <Member> seeds.
  if (effectiveProfile.dbType === "mongodb" && node.members.length > 0) {
    const replicaDatabase = getAny(node.values, ["advanceDatabase", "database", "databaseName"]);
    const useSrv = truthyNavicatFlag(getAny(node.values, ["useSRVRecord", "srvRecord"]));
    config.connection_string = buildMongoReplicaSetConnectionString({
      useSrv,
      username,
      password,
      members: node.members,
      database: replicaDatabase,
      replicaSet: getAny(node.values, ["replicaSetName", "replicaSet"]),
      authSource: getAny(node.values, ["authSource"]),
      authMechanism: getAny(node.values, ["authMechanism"]),
      readPreference: getAny(node.values, ["readPreference"]),
      retryReads: optionalNavicatFlag(getAny(node.values, ["retryReads"])),
      retryWrites: optionalNavicatFlag(getAny(node.values, ["retryWrites"])),
      ssl: truthyNavicatFlag(getAny(node.values, ["ssl", "useSsl"])),
    });
    config.host = node.members[0].host;
    config.port = node.members[0].port;
    config.database = replicaDatabase || undefined;
    config.url_params = "";
  }

  return { ...config, id: uuid() };
}

export async function parseNavicatConnections(content: string): Promise<ConnectionConfig[]> {
  const doc = new DOMParser().parseFromString(content, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("Invalid Navicat connection file");

  const seen = new Set<string>();
  const configs: ConnectionConfig[] = [];
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    const node = readNode(element);
    if (!isConnectionCandidate(node)) continue;
    const config = await parseConnection(node);
    if (!config) continue;
    const key = [config.name, config.db_type, config.host, config.port, config.database || "", config.connection_string || ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push(config);
  }
  return configs;
}

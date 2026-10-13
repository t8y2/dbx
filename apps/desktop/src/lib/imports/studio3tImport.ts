import type { ConnectionConfig, TransportLayerConfig } from "@/types/database";
import type { ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";
import { uuid } from "@/lib/common/utils";

/** Studio 3T Connection Manager exports standard MongoDB URIs to .uri files. */
export interface Studio3tUriFile {
  name: string;
  content: string;
}

export const STUDIO3T_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_CONNECTIONS = 1000;

export type Studio3tImportErrorCode = "invalid" | "tooLarge" | "unsupported";

export class Studio3tImportError extends Error {
  constructor(public readonly code: Studio3tImportErrorCode) {
    // Never put a URI (which may contain credentials) into an error.
    super(`STUDIO3T_IMPORT_${code}`);
  }
}

function invalid(): never {
  throw new Studio3tImportError("invalid");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return invalid();
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function endpoint(value: string): { host: string; port: number; explicitPort: boolean } {
  const match = value.startsWith("[") ? value.match(/^\[([0-9a-fA-F:.]+)\](?::([0-9]+))?$/) : value.match(/^([^:\s/?#@,[\]]+)(?::([0-9]+))?$/);
  if (!match) return invalid();
  const port = match[2] === undefined ? 27017 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid();
  return { host: match[1], port, explicitPort: match[2] !== undefined };
}

// Observed Studio 3T URI v3 export fields. Unknown fields must not disappear
// silently, especially when they may change the connection's transport.
const STUDIO3T_FIELDS = new Set(["3t.uriversion", "3t.connection.name", "3t.databases", "3t.alwaysshowauthdb", "3t.alwaysshowdbfromuserrole", "3t.ssh", "3t.sshaddress", "3t.sshport", "3t.sshauthmode", "3t.sshuser", "3t.sshpkpath", "3t.sshusepkpassphrase"]);

function flag(value: string): boolean {
  if (value !== "true" && value !== "false") return invalid();
  return value === "true";
}

function studio3tSettings(values: Map<string, string>): { name?: string; transport_layers?: TransportLayerConfig[] } {
  if (!values.size) return {};
  if (values.get("3t.uriversion") !== "3") throw new Studio3tImportError("unsupported");
  for (const key of ["3t.alwaysshowauthdb", "3t.alwaysshowdbfromuserrole"]) {
    if (values.has(key)) flag(values.get(key)!);
  }
  const name = values.get("3t.connection.name");
  if (name !== undefined && (!name.trim() || hasControlCharacters(name))) return invalid();
  const result: { name?: string; transport_layers?: TransportLayerConfig[] } = { name };
  const sshFields = [...values.keys()].some((key) => key.startsWith("3t.ssh") && key !== "3t.ssh");
  if (!values.has("3t.ssh")) {
    if (sshFields) return invalid();
    return result;
  }
  if (!flag(values.get("3t.ssh")!)) return result;
  if (values.get("3t.sshauthmode") !== "privateKey") throw new Studio3tImportError("unsupported");
  // The export supplies only a path, never the private key itself. A passphrase
  // requirement cannot be discarded or treated as an unprotected key.
  if (values.has("3t.sshusepkpassphrase") && flag(values.get("3t.sshusepkpassphrase")!)) throw new Studio3tImportError("unsupported");
  const host = values.get("3t.sshaddress") ?? "";
  const user = values.get("3t.sshuser") ?? "";
  const keyPath = values.get("3t.sshpkpath") ?? "";
  const rawPort = values.get("3t.sshport") ?? "22";
  if (!host || /[\s/?#@\\]/u.test(host) || hasControlCharacters(host) || !user.trim() || hasControlCharacters(user) || !keyPath.trim() || hasControlCharacters(keyPath)) return invalid();
  if (!/^[0-9]+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) return invalid();
  result.transport_layers = [
    {
      type: "ssh",
      id: uuid(),
      enabled: true,
      host,
      port: Number(rawPort),
      user,
      key_path: keyPath,
      auth_method: "key",
    },
  ];
  return result;
}

export interface Studio3tImportBundle extends ConnectionConfigBundle {
  invalidDatabaseCount: number;
}

function databaseIsInvalid(value: string): boolean {
  return /[/\\.\s"$]/u.test(value) || hasControlCharacters(value) || new TextEncoder().encode(value).byteLength > 63;
}

function connectionFromUri(uri: string, name: string, index: number): { connection: ConnectionConfig; invalidDatabase: boolean } {
  if (/\s|#/u.test(uri) || [...uri].some((character) => character.charCodeAt(0) < 32) || /%(?![0-9a-fA-F]{2})/.test(uri)) return invalid();
  const match = uri.match(/^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/);
  if (!match) return invalid();
  const [, scheme, authority, rawDatabase = "", params = ""] = match;
  const separator = authority.lastIndexOf("@");
  const credentials = separator < 0 ? "" : authority.slice(0, separator);
  if (credentials.includes("@")) return invalid();
  const passwordSeparator = credentials.indexOf(":");
  const username = decode(passwordSeparator < 0 ? credentials : credentials.slice(0, passwordSeparator));
  const password = passwordSeparator < 0 ? "" : decode(credentials.slice(passwordSeparator + 1));
  const hosts = (separator < 0 ? authority : authority.slice(separator + 1)).split(",").map(endpoint);
  if (scheme === "mongodb+srv" && (hosts.length !== 1 || hosts[0].explicitPort || hosts[0].host.includes(":"))) return invalid();
  const database = decode(rawDatabase);
  const invalidDatabase = databaseIsInvalid(database);

  let ssl = scheme === "mongodb+srv";
  const tlsValues: boolean[] = [];
  const metadata = new Map<string, string>();
  const mongoOptions: string[] = [];
  let authSource: string | undefined;
  // Standard options remain byte for byte. Studio 3T metadata uses form
  // encoding (+ means space); Mongo URI options use percent encoding instead.
  for (const part of params.split("&").filter(Boolean)) {
    const equals = part.indexOf("=");
    if (equals < 1) return invalid();
    const key = decode(part.slice(0, equals)).toLowerCase();
    if (key.startsWith("3t.")) {
      if (!STUDIO3T_FIELDS.has(key)) throw new Studio3tImportError("unsupported");
      if (metadata.has(key)) return invalid();
      metadata.set(key, decode(part.slice(equals + 1).replace(/\+/g, "%20")));
      continue;
    }
    const value = decode(part.slice(equals + 1));
    if (/ssh|proxy|^3t|^studio3t/.test(key)) throw new Studio3tImportError("unsupported");
    mongoOptions.push(part);
    if (key === "authsource") {
      if (authSource !== undefined && value !== authSource) return invalid();
      authSource = value;
    }
    if (key === "ssl" || key === "tls") {
      if (value !== "true" && value !== "false") return invalid();
      tlsValues.push(value === "true");
      ssl = value === "true";
    }
  }
  if (tlsValues.some((value) => value !== tlsValues[0])) return invalid();
  const settings = studio3tSettings(metadata);
  // Some v3 exports contain an invalid default DB despite a separate valid
  // authSource. Clear only that default, retaining explicit authentication and
  // surfacing a preview warning and the original database in the connection note.
  if (invalidDatabase && (!metadata.size || !authSource || databaseIsInvalid(authSource) || hasControlCharacters(database))) return invalid();
  const uriBase = invalidDatabase ? `${scheme}://${authority}/` : uri.split("?")[0];
  const connectionString = metadata.size ? uriBase + (mongoOptions.length ? `?${mongoOptions.join("&")}` : "") : uri;

  return {
    invalidDatabase,
    connection: {
      id: `__studio3t_import_${index}`,
      name: settings.name ?? name,
      db_type: "mongodb",
      driver_profile: "mongodb",
      driver_label: "MongoDB",
      host: hosts[0].host,
      port: hosts[0].port,
      username,
      password,
      database: invalidDatabase ? undefined : database || undefined,
      ...(invalidDatabase ? { note: `Studio 3T: review the original default database ${JSON.stringify(database)}; it was omitted because MongoDB database names cannot contain these characters.` } : {}),
      connection_string: connectionString,
      ssl,
      ...(settings.transport_layers ? { transport_layers: settings.transport_layers } : {}),
    },
  };
}

/** Pure preview only: no persistence, decryption, or database access. */
export function parseStudio3tUriFiles(files: Studio3tUriFile[]): Studio3tImportBundle {
  if (!files.length || files.length > MAX_CONNECTIONS) return invalid();
  let bytes = 0;
  let invalidDatabaseCount = 0;
  const connections: ConnectionConfig[] = [];
  for (const file of files) {
    if (typeof file?.name !== "string" || typeof file?.content !== "string") return invalid();
    bytes += new TextEncoder().encode(file.content).byteLength;
    if (bytes > STUDIO3T_IMPORT_MAX_BYTES) throw new Studio3tImportError("tooLarge");
    const lines = file.content
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"));
    if (!lines.length || connections.length + lines.length > MAX_CONNECTIONS) return invalid();
    const baseName =
      file.name
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.uri$/i, "")
        .trim() || "MongoDB";
    for (const [index, uri] of lines.entries()) {
      const parsed = connectionFromUri(uri, lines.length === 1 ? baseName : `${baseName} (${index + 1})`, connections.length);
      connections.push(parsed.connection);
      if (parsed.invalidDatabase) invalidDatabaseCount++;
    }
  }
  return { connections, invalidDatabaseCount };
}

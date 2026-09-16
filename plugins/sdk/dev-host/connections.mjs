import { mkdir, readFile, writeFile, rename, chmod, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function providerFor(manifest, id) {
  const provider = manifest.contributions?.find((c) => c.type === "connection-provider" && c.id === id);
  if (!provider) throw new Error("Unknown connection provider");
  return provider;
}
export function binding(field) {
  return field.binding || (field.type === "password" ? "secret" : "config");
}
export function validateRecord(manifest, record, required = true) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid connection record");
  if (record.id !== undefined && (typeof record.id !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(record.id))) throw new Error("Invalid connection ID");
  const provider = providerFor(manifest, record.providerId);
  if (!record.values || typeof record.values !== "object" || Array.isArray(record.values)) throw new Error("Invalid connection fields");
  if (Object.keys(record.values).some((key) => !provider.fields.some((f) => f.key === key))) throw new Error("Unknown connection field");
  const values = {};
  for (const f of provider.fields) {
    const value = record.values[f.key] ?? f.default;
    const empty = value === undefined || value === null || value === "";
    if (empty) {
      if (required && f.required) throw new Error(`Missing field: ${f.key}`);
      continue;
    }
    if (f.type === "number" ? typeof value !== "number" || !Number.isFinite(value) : f.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string") {
      throw new Error(`Invalid field type: ${f.key}`);
    }
    if (["select", "radio"].includes(f.type) && !f.options?.some((option) => option.value === value)) throw new Error(`Invalid option: ${f.key}`);
    if (binding(f) === "port" && (!Number.isInteger(value) || value < 0 || value > 65535)) throw new Error("Port must be between 0 and 65535");
    Object.defineProperty(values, f.key, { enumerable: true, configurable: true, writable: true, value });
  }
  if (record.readOnly !== undefined && typeof record.readOnly !== "boolean") throw new Error("Invalid read-only value");
  return { id: record.id || randomUUID(), providerId: provider.id, values, readOnly: record.readOnly || false };
}
export function lifecyclePayload(manifest, record) {
  const provider = providerFor(manifest, record.providerId);
  const c = {
    id: record.id,
    db_type: "plugin",
    plugin_id: manifest.id,
    plugin_connection_provider: provider.id,
    plugin_connection_type: provider.database_type,
    name: provider.label,
    host: "",
    port: 0,
    username: "",
    external_config: {},
    connection_secrets: {},
    read_only: record.readOnly,
    query_timeout_secs: 60,
    idle_timeout_secs: 60,
  };
  for (const f of provider.fields) {
    const value = record.values[f.key] ?? f.default;
    if (value === undefined || value === null) continue;
    const target = binding(f);
    if (target === "config") Object.defineProperty(c.external_config, f.key, { value, enumerable: true });
    else if (target === "secret") Object.defineProperty(c.connection_secrets, f.key, { value: String(value), enumerable: true });
    else if (["name", "host", "port", "username", "password", "database"].includes(target)) c[target] = value;
    else throw new Error("Unsupported field binding");
  }
  return { provider: { id: provider.id, databaseType: provider.database_type }, connection: c, runtime: null };
}
export function summary(manifest, record) {
  const provider = providerFor(manifest, record.providerId);
  const name = provider.fields.find((f) => binding(f) === "name");
  return { id: record.id, providerId: record.providerId, name: name ? record.values[name.key] || provider.label : provider.label, label: provider.label };
}

export class ConnectionStore {
  records = [];
  constructor(directory, manifest) {
    this.directory = directory;
    this.manifest = manifest;
    this.file = join(directory, "connections.json");
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error("Data directory cannot be a symlink");
    await chmod(this.directory, 0o700);
    try {
      if ((await lstat(this.file)).isSymbolicLink()) throw new Error("Connection store cannot be a symlink");
      const stored = JSON.parse(await readFile(this.file, "utf8"));
      if (stored.pluginId !== this.manifest.id || stored.version !== 1 || !Array.isArray(stored.connections)) throw new Error("Invalid connection store");
      this.records = stored.connections.map((r) => validateRecord(this.manifest, r, false));
      if (new Set(this.records.map((r) => r.id)).size !== this.records.length) throw new Error("Duplicate connection IDs");
      await chmod(this.file, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  get(id) {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error("Connection not found");
    return structuredClone(record);
  }
  async replace(records) {
    const next = records.map((r) => validateRecord(this.manifest, r, false));
    const temporary = join(this.directory, `.connections-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, pluginId: this.manifest.id, connections: next }, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.file);
    this.records = next;
  }
}

import { describe, expect, it } from "vitest";
import { cbc, ecb } from "@noble/ciphers/aes.js";
import { deflateRaw } from "pako";
import { isSqlarkImportPayload, parseSqlarkImport } from "@/lib/imports/sqlarkImport";

// The fixture is synthesised here with the same primitives SQLark uses, so the
// repository never carries a real user backup (which contains hosts and secrets).
const BACKUP_KEY = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const CONNECTION_COLUMNS = ["ID", "DB_TYPE", "DB_VERSION", "CONNECTION_NAME", "CONNECTION_TYPE", "CONNECTION_DETAIL", "HOST", "PORT", "USER_ID", "USER_NAME", "STATE", "COLOR", "SORT", "CREATE_TIME", "UPDATED_TIME", "LAST_ROOT_REFRESH_TIME", "DRIVER_ID", "IS_PRODUCE"];

function encryptBackupLine(statement: string): string {
  const cipher = ecb(BACKUP_KEY).encrypt(new TextEncoder().encode(statement));
  return Buffer.from(cipher).toString("base64");
}

function encryptPassword(password: string, salt: string): string {
  const key = new TextEncoder().encode(salt);
  const iv = new TextEncoder().encode(Array.from(salt).reverse().join(""));
  return Buffer.from(cbc(key, iv).encrypt(new TextEncoder().encode(password))).toString("base64");
}

function insert(table: string, columns: string[], values: (string | null)[]): string {
  const literals = values.map((value) => (value === null ? "null" : `'${value.replace(/'/g, "''")}'`));
  return `INSERT INTO public.${table}(${columns.join(",")})VALUES(${literals.join(",")});`;
}

function connectionRow(options: { id: string; dbType: string; name: string; host: string; port: number; user: string; color?: string; detail: Record<string, unknown> }): string {
  return insert("CONNECTION_INFO", CONNECTION_COLUMNS, [
    options.id,
    options.dbType,
    "8",
    options.name,
    "DEFAULT",
    JSON.stringify(options.detail),
    options.host,
    String(options.port),
    "1",
    options.user,
    "0",
    options.color ?? "",
    "0",
    "2026-01-01 00:00:00.0",
    "2026-01-01 00:00:00.0",
    null,
    "drv-1",
    "0",
  ]);
}

function backupFile(statements: string[], version = "4.1"): Uint8Array {
  const header = [`-- VERSION: ${version}`, "-- FINGERPRINT: synthetictestfingerprint=="];
  return new TextEncoder().encode([...header, ...statements.map(encryptBackupLine)].join("\n"));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Minimal ZIP writer: only what the importer's reader consumes (sizes + method). */
function buildZip(files: Record<string, Uint8Array>, method: 0 | 8 = 8): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let offset = 0;

  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const payload = method === 8 ? deflateRaw(data) : data;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localChunks.push(local, payload);
    centralChunks.push(central);
    offset += local.length + payload.length;
  }

  const centralSize = centralChunks.reduce((size, chunk) => size + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  const entryCount = Object.keys(files).length;
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entryCount, true);
  eocdView.setUint16(10, entryCount, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  return concat([...localChunks, ...centralChunks, eocd]);
}

function payloadFor(files: Record<string, Uint8Array>, method: 0 | 8 = 8) {
  return { format: "sqlark-import" as const, zipBase64: Buffer.from(buildZip(files, method)).toString("base64") };
}

const SALT = "AbCdEfGh12345678";
const SALT_DETAIL = { dbType: "DM", dbVersion: "8", host: "10.1.2.3", port: 5237, user: "SYSDBA", salt: SALT, password: encryptPassword("s3cret", SALT), rememberPassword: true, keepAlive: true, keepAliveInterval: 240 };

function standardFiles(): Record<string, Uint8Array> {
  const groups = [
    insert("CONNECT_GROUP", ["ID", "PID", "USER_ID", "NAME", "CREATE_TIME", "UPDATE_TIME", "STATUS", "SORT", "REMARK"], ["g-prod", "0", "1", "生产", "2026-01-01", "2026-01-01", "1", "1", null]),
    insert("CONNECT_GROUP", ["ID", "PID", "USER_ID", "NAME", "CREATE_TIME", "UPDATE_TIME", "STATUS", "SORT", "REMARK"], ["g-dm", "g-prod", "1", "达梦", "2026-01-01", "2026-01-01", "1", "0", null]),
  ];
  const memberships = [insert("CONNECT_GROUP_DETAIL", ["ID", "GROUP_ID", "CONNECT_ID"], ["m1", "g-dm", "c1"])];
  const connections = [
    connectionRow({ id: "c1", dbType: "DM", name: "核心库", host: "10.1.2.3", port: 5237, user: "SYSDBA", color: "#ff0000", detail: SALT_DETAIL }),
    connectionRow({ id: "c2", dbType: "MYSQL", name: "localhost - MySQL", host: "127.0.0.1", port: 3306, user: "root", detail: { dbType: "MYSQL", host: "127.0.0.1", port: 3306, user: "root", rememberPassword: false } }),
    connectionRow({ id: "c3", dbType: "DB2", name: "unsupported", host: "10.9.9.9", port: 50000, user: "db2inst1", detail: { dbType: "DB2" } }),
  ];
  return {
    ".metadata": new TextEncoder().encode("unused-by-parser"),
    "sqlark_setting.bak": backupFile([...connections, ...groups, ...memberships]),
    "folders/connectInfo.txt": new TextEncoder().encode("c1|核心库\nc2|localhost - MySQL"),
  };
}

describe("SQLark config backup import", () => {
  it("restores connections, recoverable passwords and the nested group tree", async () => {
    const result = await parseSqlarkImport(payloadFor(standardFiles()));

    expect(result.connections).toHaveLength(2);
    expect(result.skippedCount).toBe(1);
    expect(result.passwordCount).toBe(1);
    expect(result.version).toBe("4.1");

    const [first, second] = result.connections;
    expect(first).toMatchObject({ name: "核心库", host: "10.1.2.3", port: 5237, username: "SYSDBA", db_type: "dameng", driver_profile: "dm", password: "s3cret", color: "#ff0000", keepalive_interval_secs: 240 });
    // rememberPassword=false keeps the prompt-based flow instead of a bogus secret.
    expect(second).toMatchObject({ name: "localhost - MySQL", db_type: "mysql", password: "" });
    expect(first!.id).not.toBe("c1");

    const layout = result.layout!;
    expect(layout.groups.map((group) => group.name)).toEqual(["生产", "达梦"]);
    const outer = layout.order[0];
    expect(outer.type).toBe("group");
    const inner = outer.type === "group" ? outer.children?.[0] : undefined;
    expect(inner?.type).toBe("group");
    expect(inner?.type === "group" ? inner.children : []).toEqual([{ type: "connection", id: first!.id }]);
    // The ungrouped connection stays at the root.
    expect(layout.order).toContainEqual({ type: "connection", id: second!.id });
  });

  it("reads stored (uncompressed) archive members as well", async () => {
    const result = await parseSqlarkImport(payloadFor(standardFiles(), 0));
    expect(result.connections).toHaveLength(2);
  });

  it("leaves the password empty when the salt cannot decrypt it", async () => {
    const files = standardFiles();
    const broken = {
      ...SALT_DETAIL,
      salt: "FFFFFFFFFFFFFFFF",
    };
    files["sqlark_setting.bak"] = backupFile([connectionRow({ id: "c1", dbType: "DM", name: "wrong-salt", host: "h", port: 5236, user: "u", detail: broken })]);
    const result = await parseSqlarkImport(payloadFor(files));
    expect(result.connections[0]!.password).toBe("");
    expect(result.passwordCount).toBe(0);
  });

  it("decodes escaped quotes and null columns", async () => {
    const files = standardFiles();
    files["sqlark_setting.bak"] = backupFile([connectionRow({ id: "c1", dbType: "DM", name: "O'Brien 库", host: "h", port: 5236, user: "u", detail: { ...SALT_DETAIL, comment: null } })]);
    const result = await parseSqlarkImport(payloadFor(files));
    expect(result.connections[0]!.name).toBe("O'Brien 库");
  });

  it("reports a format change instead of importing nothing silently", async () => {
    const files = standardFiles();
    files["sqlark_setting.bak"] = backupFile([connectionRow({ id: "c1", dbType: "DM", name: "future", host: "h", port: 5236, user: "u", detail: {} })], "5.0");
    await expect(parseSqlarkImport(payloadFor(files))).rejects.toThrow("Unsupported SQLark backup version 5.0");
  });

  it("rejects archives without a backup member or without connections", async () => {
    await expect(parseSqlarkImport(payloadFor({ "readme.txt": new TextEncoder().encode("nope") }))).rejects.toThrow("sqlark_setting.bak is missing");

    const onlyGroups = {
      "sqlark_setting.bak": backupFile([insert("CONNECT_GROUP", ["ID", "PID", "USER_ID", "NAME", "CREATE_TIME", "UPDATE_TIME", "STATUS", "SORT", "REMARK"], ["g1", "0", "1", "空组", "2026-01-01", "2026-01-01", "1", "0", null])]),
    };
    await expect(parseSqlarkImport(payloadFor(onlyGroups))).rejects.toThrow("contains no database connections");
  });

  it("recognises its own payload shape only", () => {
    expect(isSqlarkImportPayload({ format: "sqlark-import", zipBase64: "AA==" })).toBe(true);
    expect(isSqlarkImportPayload({ format: "datagrip-import", dataSources: "" })).toBe(false);
    expect(isSqlarkImportPayload({ format: "sqlark-import", zipBase64: "" })).toBe(false);
    expect(isSqlarkImportPayload(null)).toBe(false);
  });
});

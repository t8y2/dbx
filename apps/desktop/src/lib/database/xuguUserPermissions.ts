import type { QueryResult } from "@/types/database";

export type XuguPrivilegeScope = "system" | "database" | "schema" | "object" | "column" | "role" | "admin";
export type XuguAdminAuthority = "DBA" | "AUDITOR" | "SSO";

export interface XuguPrincipal {
  id: string;
  name: string;
  isRole: boolean;
  locked: boolean;
  expired: boolean;
  isSystem: boolean;
  validUntil?: string;
  alias?: string;
}

export interface XuguAclRow {
  grantorId: string;
  granteeId: string;
  objectId: string;
  objectType: number;
  authority: string;
  regrant: boolean;
  target: string;
  scope: "system" | "database" | "schema" | "object" | "column";
  inheritedFrom?: string;
}

export interface XuguPrivilege {
  name: string;
  authorityType: number;
  authorityBit: number;
}

export interface XuguGrantInput {
  principal: XuguPrincipal;
  scope: XuguPrivilegeScope;
  privileges?: string[];
  schema?: string;
  objectType?: string;
  object?: string;
  column?: string;
  role?: string;
  adminAuthority?: XuguAdminAuthority;
  grantOption?: boolean;
  revokeGrantOptionOnly?: boolean;
  systemDatabase?: boolean;
}

export interface XuguCreateUserOptions {
  defaultRoles?: string[];
  validUntil?: string;
  locked?: boolean;
  passwordExpired?: boolean;
}

export interface XuguAlterAccountOptions {
  validUntil?: string;
  passwordExpired?: boolean;
}

const DB_ACL = {
  READ_ANY: 0x1,
  UPDATE_ANY: 0x2,
  INSERT_ANY: 0x4,
  DELETE_ANY: 0x8,
  REF_ANY: 0x10,
  EXECUTE_ANY: 0x20,
  INDEX_ANY: 0x40,
  CREATE: 0x80,
  CREATE_ANY: 0x100,
  ALTER_ANY: 0x200,
  DROP_ANY: 0x400,
  BACKUP_ANY: 0x800,
  RESTORE_ANY: 0x1000,
  VACUUM_ANY: 0x2000,
  REPLICATION_ANY: 0x4000,
  REFRESH_ANY: 0x8000,
  GRANT_ANY: 0x10000,
  ENCRYPT_ANY: 0x20000,
  CREATE_JOB: 0x40000,
  TRACE: 0x80000,
  DBA: 0x7fffff,
  DBO: 0xffffff,
  AUDITOR: 0x10000000,
  AUDIT_ADMIN: 0x30000000,
  SSO: 0x40000000,
  SS_ADMIN: 0xc0000000,
} as const;

const OBJECT_ACL = {
  READ: 0x1,
  UPDATE: 0x2,
  INSERT: 0x4,
  DELETE: 0x8,
  REFERENCES: 0x10,
  EXECUTE: 0x20,
  INDEX: 0x40,
  ALTER: 0x80,
  DROP: 0x100,
  TRIGGER: 0x200,
  VACUUM: 0x400,
} as const;

export const XUGU_OBJECT_TYPES = [
  { label: "Table", sql: "TABLE", type: 5 },
  { label: "View", sql: "VIEW", type: 9 },
  { label: "Procedure / Function", sql: "PROCEDURE", type: 7 },
  { label: "Sequence", sql: "SEQUENCE", type: 8 },
  { label: "Package", sql: "PACKAGE", type: 18 },
  { label: "User-defined type", sql: "OBJECT", type: 19 },
] as const;

const DATABASE_PRIVILEGES: XuguPrivilege[] = [
  { name: "CREATE ANY SCHEMA", authorityType: 4, authorityBit: DB_ACL.CREATE_ANY },
  { name: "ALTER ANY SCHEMA", authorityType: 4, authorityBit: DB_ACL.ALTER_ANY },
  { name: "DROP ANY SCHEMA", authorityType: 4, authorityBit: DB_ACL.DROP_ANY },
  ...(
    [
      [
        "TABLE",
        5,
        ["CREATE", DB_ACL.CREATE],
        ["CREATE ANY", DB_ACL.CREATE_ANY],
        ["ALTER ANY", DB_ACL.ALTER_ANY],
        ["DROP ANY", DB_ACL.DROP_ANY],
        ["SELECT ANY", DB_ACL.READ_ANY],
        ["INSERT ANY", DB_ACL.INSERT_ANY],
        ["UPDATE ANY", DB_ACL.UPDATE_ANY],
        ["DELETE ANY", DB_ACL.DELETE_ANY],
        ["REFERENCES ANY", DB_ACL.REF_ANY],
      ],
      ["VIEW", 9, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY], ["SELECT ANY", DB_ACL.READ_ANY], ["INSERT ANY", DB_ACL.INSERT_ANY], ["UPDATE ANY", DB_ACL.UPDATE_ANY], ["DELETE ANY", DB_ACL.DELETE_ANY]],
      ["SEQUENCE", 8, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY], ["SELECT ANY", DB_ACL.READ_ANY], ["UPDATE ANY", DB_ACL.UPDATE_ANY], ["REFERENCES ANY", DB_ACL.REF_ANY]],
      ["PACKAGE", 18, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY], ["EXECUTE ANY", DB_ACL.EXECUTE_ANY]],
      ["PROCEDURE", 7, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY], ["EXECUTE ANY", DB_ACL.EXECUTE_ANY]],
      ["TRIGGER", 11, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
      ["INDEX", 10, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
      ["SYNONYM", 15, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
      ["DATABASE LINK", 12, ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
      ["USER", 16, ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
      ["ROLE", 17, ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
      ["JOB", 22, ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
      ["OBJECT", 19, ["CREATE", DB_ACL.CREATE], ["CREATE ANY", DB_ACL.CREATE_ANY], ["ALTER ANY", DB_ACL.ALTER_ANY], ["DROP ANY", DB_ACL.DROP_ANY]],
    ] as Array<[string, number, ...Array<[string, number]>]>
  ).flatMap(([type, objectType, ...items]) => items.map(([verb, authorityBit]) => ({ name: `${verb} ${type}`, authorityType: objectType, authorityBit }))),
  ...(
    [
      ["BACKUP", DB_ACL.BACKUP_ANY],
      ["RESTORE", DB_ACL.RESTORE_ANY],
      ["VACUUM ANY", DB_ACL.VACUUM_ANY],
      ["REPLICATION ANY", DB_ACL.REPLICATION_ANY],
      ["REFRESH ANY", DB_ACL.REFRESH_ANY],
      ["GRANT ANY", DB_ACL.GRANT_ANY],
      ["ENCRYPT ANY", DB_ACL.ENCRYPT_ANY],
      // CREATE_JOB is the database-wide job creation bit without an object
      // type. Keep it distinct from CREATE ANY JOB (object type JOB), which
      // is backed by DB_ACL.CREATE_ANY and authorityType 22 above.
      ["CREATE JOB", DB_ACL.CREATE_JOB],
      ["TRACE", DB_ACL.TRACE],
    ] as Array<[string, number]>
  ).map(([name, authorityBit]) => ({ name, authorityType: 0, authorityBit })),
];

// Database lifecycle privileges are instance-wide and are only actionable
// from the SYSTEM database. Keep them out of the regular database grant set.
const SYSTEM_DATABASE_PRIVILEGES: XuguPrivilege[] = [
  { name: "CREATE ANY DATABASE", authorityType: 1, authorityBit: DB_ACL.CREATE_ANY },
  { name: "ALTER ANY DATABASE", authorityType: 1, authorityBit: DB_ACL.ALTER_ANY },
  { name: "DROP ANY DATABASE", authorityType: 1, authorityBit: DB_ACL.DROP_ANY },
];

// A schema ACL targets the objects inside one schema, so only the ANY-level
// object privileges are valid here (never database-wide or own-schema CREATE).
const SCHEMA_PRIVILEGE_TYPES = new Set([5, 9, 8, 18, 7, 11, 10, 15, 19]);
const SCHEMA_PRIVILEGES = DATABASE_PRIVILEGES.filter((privilege) => SCHEMA_PRIVILEGE_TYPES.has(privilege.authorityType) && privilege.name.includes(" ANY "));

const OBJECT_PRIVILEGES: Record<number, Array<[string, number]>> = {
  5: [
    ["SELECT", OBJECT_ACL.READ],
    ["INSERT", OBJECT_ACL.INSERT],
    ["UPDATE", OBJECT_ACL.UPDATE],
    ["DELETE", OBJECT_ACL.DELETE],
    ["REFERENCES", OBJECT_ACL.REFERENCES],
    ["ALTER", OBJECT_ACL.ALTER],
    ["DROP", OBJECT_ACL.DROP],
    ["INDEX", OBJECT_ACL.INDEX],
    ["TRIGGER", OBJECT_ACL.TRIGGER],
    ["VACUUM", OBJECT_ACL.VACUUM],
  ],
  6: [
    ["SELECT", OBJECT_ACL.READ],
    ["UPDATE", OBJECT_ACL.UPDATE],
  ],
  7: [
    ["EXECUTE", OBJECT_ACL.EXECUTE],
    ["ALTER", OBJECT_ACL.ALTER],
    ["DROP", OBJECT_ACL.DROP],
  ],
  8: [
    ["SELECT", OBJECT_ACL.READ],
    ["UPDATE", OBJECT_ACL.UPDATE],
    ["ALTER", OBJECT_ACL.ALTER],
    ["DROP", OBJECT_ACL.DROP],
  ],
  9: [
    ["SELECT", OBJECT_ACL.READ],
    ["INSERT", OBJECT_ACL.INSERT],
    ["UPDATE", OBJECT_ACL.UPDATE],
    ["DELETE", OBJECT_ACL.DELETE],
    ["ALTER", OBJECT_ACL.ALTER],
    ["DROP", OBJECT_ACL.DROP],
  ],
  11: [
    ["ALTER", OBJECT_ACL.ALTER],
    ["DROP", OBJECT_ACL.DROP],
  ],
  18: [
    ["EXECUTE", OBJECT_ACL.EXECUTE],
    ["ALTER", OBJECT_ACL.ALTER],
    ["DROP", OBJECT_ACL.DROP],
  ],
  19: [
    ["EXECUTE", OBJECT_ACL.EXECUTE],
    ["ALTER", OBJECT_ACL.ALTER],
    ["DROP", OBJECT_ACL.DROP],
  ],
  28: [
    ["SELECT", OBJECT_ACL.READ],
    ["UPDATE", OBJECT_ACL.UPDATE],
  ],
};

const OBJECT_TYPE_LABELS = new Map<number, string>([
  [1, "DATABASE"],
  [4, "SCHEMA"],
  [5, "TABLE"],
  [6, "COLUMN"],
  [7, "PROCEDURE"],
  [8, "SEQUENCE"],
  [9, "VIEW"],
  [10, "INDEX"],
  [11, "TRIGGER"],
  [12, "DATABASE LINK"],
  [13, "REPLICATION"],
  [15, "SYNONYM"],
  [16, "USER"],
  [17, "ROLE"],
  [18, "PACKAGE"],
  [19, "OBJECT"],
  [22, "JOB"],
  [28, "VIEW COLUMN"],
  [29, "DOMAIN"],
]);

export function xuguQuoteIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized || [...normalized].some((character) => character.charCodeAt(0) < 32)) throw new Error("An identifier is required.");
  return `"${normalized.replace(/"/g, '""')}"`;
}

export function xuguQuoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("Invalid string value.");
  return `'${value.replace(/'/g, "''")}'`;
}

export function xuguDatabaseOptions(names: string[], currentDatabase = ""): string[] {
  const options = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const current = currentDatabase.trim();
  if (current && !options.includes(current)) options.push(current);
  return options.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

export function xuguListUsersSql(): string {
  return "SELECT USER_ID, USER_NAME, LOCKED, EXPIRED, IS_SYS, UNTIL_TIME, ALIAS FROM DBA_USERS WHERE DB_ID = CURRENT_DB_ID AND IS_ROLE = FALSE ORDER BY USER_NAME;";
}

export function xuguListRolesSql(): string {
  return "SELECT USER_ID, USER_NAME, IS_SYS FROM DBA_ROLES WHERE DB_ID = CURRENT_DB_ID AND IS_ROLE = TRUE ORDER BY USER_NAME;";
}

export function xuguFallbackListRolesSql(): string {
  return "SELECT USER_ID, USER_NAME, IS_SYS FROM ALL_USERS WHERE DB_ID = CURRENT_DB_ID AND IS_ROLE = TRUE ORDER BY USER_NAME;";
}

export function xuguListSchemasSql(useDbaCatalog = true): string {
  const catalog = useDbaCatalog ? "DBA_SCHEMAS" : "ALL_SCHEMAS";
  return `SELECT SCHEMA_ID, SCHEMA_NAME FROM ${catalog} WHERE DB_ID = CURRENT_DB_ID ORDER BY SCHEMA_NAME;`;
}

export function xuguListObjectNamesSql(schema: string, objectType: string, useDbaCatalog = true): string {
  const type = XUGU_OBJECT_TYPES.find((item) => item.sql === objectType);
  if (!type) throw new Error("Choose a supported object type.");
  const catalog = useDbaCatalog ? "DBA" : "ALL";
  return `SELECT O.OBJ_NAME FROM ${catalog}_OBJECTS O JOIN ${catalog}_SCHEMAS S ON O.SCHEMA_ID = S.SCHEMA_ID AND O.DB_ID = S.DB_ID WHERE O.DB_ID = CURRENT_DB_ID AND S.DB_ID = CURRENT_DB_ID AND S.SCHEMA_NAME = ${xuguQuoteLiteral(schema)} AND O.OBJ_TYPE = ${type.type} ORDER BY O.OBJ_NAME;`;
}

export function xuguListColumnNamesSql(schema: string, object: string, objectType: string, useDbaCatalog = true): string {
  const schemaLiteral = xuguQuoteLiteral(schema);
  const objectLiteral = xuguQuoteLiteral(object);
  const catalog = useDbaCatalog ? "DBA" : "ALL";
  if (objectType === "VIEW") {
    return `SELECT C.COL_NAME FROM ${catalog}_VIEW_COLUMNS C JOIN ${catalog}_VIEWS V ON C.VIEW_ID = V.VIEW_ID AND C.DB_ID = V.DB_ID JOIN ${catalog}_SCHEMAS S ON V.SCHEMA_ID = S.SCHEMA_ID AND V.DB_ID = S.DB_ID WHERE C.DB_ID = CURRENT_DB_ID AND S.DB_ID = CURRENT_DB_ID AND S.SCHEMA_NAME = ${schemaLiteral} AND V.VIEW_NAME = ${objectLiteral} ORDER BY C.COL_NO;`;
  }
  if (objectType !== "TABLE") throw new Error("Column grants are supported only for tables and views.");
  return `SELECT C.COL_NAME FROM ${catalog}_COLUMNS C JOIN ${catalog}_TABLES T ON C.TABLE_ID = T.TABLE_ID AND C.DB_ID = T.DB_ID JOIN ${catalog}_SCHEMAS S ON T.SCHEMA_ID = S.SCHEMA_ID AND T.DB_ID = S.DB_ID WHERE C.DB_ID = CURRENT_DB_ID AND S.DB_ID = CURRENT_DB_ID AND S.SCHEMA_NAME = ${schemaLiteral} AND T.TABLE_NAME = ${objectLiteral} ORDER BY C.COL_NO;`;
}

export function xuguFallbackListUsersSql(): string {
  return "SELECT USER_ID, USER_NAME, LOCKED, EXPIRED, IS_SYS, UNTIL_TIME, ALIAS FROM ALL_USERS WHERE DB_ID = CURRENT_DB_ID AND IS_ROLE = FALSE ORDER BY USER_NAME;";
}

export function xuguRoleMembershipsSql(): string {
  return "SELECT USER_ID, ROLE_ID FROM DBA_ROLE_MEMBERS WHERE DB_ID = CURRENT_DB_ID ORDER BY USER_ID, ROLE_ID;";
}

export function xuguRoleMembershipsFallbackSql(): string {
  return "SELECT USER_ID, ROLE_ID FROM ALL_ROLE_MEMBERS WHERE DB_ID = CURRENT_DB_ID ORDER BY USER_ID, ROLE_ID;";
}

export function xuguAclRowsSql(principalIds: string[], useDbaCatalog = true): string {
  const catalog = useDbaCatalog ? "DBA" : "ALL";
  const ids = [...new Set(principalIds.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
  if (ids.length === 0) return `SELECT GRANTOR_ID, GRANTEE_ID, OBJECT_ID, OBJECT_TYPE, AUTHORITY, REGRANT, 'database' AS SCOPE, 'Current database' AS TARGET_NAME FROM ${catalog}_ACLS WHERE 1 = 0;`;
  return `SELECT A.GRANTOR_ID, A.GRANTEE_ID, A.OBJECT_ID, A.OBJECT_TYPE, A.AUTHORITY, A.REGRANT,
CASE WHEN A.OBJECT_ID = 0 THEN 'database' WHEN A.OBJECT_ID < 0 OR A.OBJECT_TYPE = 4 THEN 'schema' WHEN A.OBJECT_TYPE IN (6, 28) THEN 'column' ELSE 'object' END AS SCOPE,
CASE WHEN A.OBJECT_ID = 0 THEN 'Current database'
     WHEN A.OBJECT_ID < 0 OR A.OBJECT_TYPE = 4 THEN COALESCE(S.SCHEMA_NAME, 'Schema ID ' || CASE WHEN A.OBJECT_ID < 0 THEN -A.OBJECT_ID ELSE A.OBJECT_ID END)
     WHEN A.OBJECT_TYPE IN (6, 28) THEN 'Column object ID ' || A.OBJECT_ID
     WHEN SO.SCHEMA_NAME IS NOT NULL AND O.OBJ_NAME IS NOT NULL THEN SO.SCHEMA_NAME || '.' || O.OBJ_NAME
     ELSE 'Object ID ' || A.OBJECT_ID END AS TARGET_NAME
FROM ${catalog}_ACLS A
LEFT JOIN ${catalog}_SCHEMAS S ON (A.OBJECT_ID < 0 OR A.OBJECT_TYPE = 4) AND S.SCHEMA_ID = CASE WHEN A.OBJECT_ID < 0 THEN -A.OBJECT_ID ELSE A.OBJECT_ID END AND A.DB_ID = S.DB_ID
LEFT JOIN ${catalog}_OBJECTS O ON A.OBJECT_ID > 0 AND A.OBJECT_TYPE NOT IN (4, 6, 28) AND A.OBJECT_ID = O.OBJ_ID AND A.OBJECT_TYPE = O.OBJ_TYPE AND A.DB_ID = O.DB_ID
LEFT JOIN ${catalog}_SCHEMAS SO ON O.SCHEMA_ID = SO.SCHEMA_ID AND O.DB_ID = SO.DB_ID
WHERE A.DB_ID = CURRENT_DB_ID AND A.GRANTEE_ID IN (${ids.join(", ")})
ORDER BY A.GRANTEE_ID, A.OBJECT_ID, A.OBJECT_TYPE;`;
}

export function xuguAclRowsFallbackSql(principalIds: string[]): string {
  return xuguAclRowsSql(principalIds, false);
}

/**
 * Column ACL object IDs pack the parent object ID and column ordinal. Resolve
 * them separately from the base ACL query so an unsupported catalog/function
 * on an older server does not hide otherwise readable grants.
 */
export function xuguAclColumnTargetsSql(principalIds: string[], useDbaCatalog = true): string {
  const catalog = useDbaCatalog ? "DBA" : "ALL";
  const ids = [...new Set(principalIds.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
  if (ids.length === 0) {
    return `SELECT GRANTEE_ID, OBJECT_ID, OBJECT_TYPE, '' AS TARGET_NAME FROM ${catalog}_ACLS WHERE 1 = 0;`;
  }
  return `SELECT A.GRANTEE_ID, A.OBJECT_ID, A.OBJECT_TYPE,
CASE WHEN A.OBJECT_TYPE = 6 THEN COALESCE(TS.SCHEMA_NAME || '.' || T.TABLE_NAME || '.' || C.COL_NAME, 'Column object ID ' || A.OBJECT_ID)
     WHEN A.OBJECT_TYPE = 28 THEN COALESCE(VS.SCHEMA_NAME || '.' || V.VIEW_NAME || '.' || VC.COL_NAME, 'Column object ID ' || A.OBJECT_ID)
     ELSE 'Column object ID ' || A.OBJECT_ID END AS TARGET_NAME
FROM ${catalog}_ACLS A
LEFT JOIN ${catalog}_TABLES T ON A.OBJECT_TYPE = 6 AND A.OBJECT_ID > 0 AND T.TABLE_ID = SHR(A.OBJECT_ID, 10) AND T.DB_ID = A.DB_ID
LEFT JOIN ${catalog}_COLUMNS C ON A.OBJECT_TYPE = 6 AND C.TABLE_ID = T.TABLE_ID AND C.DB_ID = T.DB_ID AND C.COL_NO = BIT_AND(A.OBJECT_ID, 1023)
LEFT JOIN ${catalog}_SCHEMAS TS ON T.SCHEMA_ID = TS.SCHEMA_ID AND T.DB_ID = TS.DB_ID
LEFT JOIN ${catalog}_VIEWS V ON A.OBJECT_TYPE = 28 AND A.OBJECT_ID > 0 AND V.VIEW_ID = SHR(A.OBJECT_ID, 10) AND V.DB_ID = A.DB_ID
LEFT JOIN ${catalog}_VIEW_COLUMNS VC ON A.OBJECT_TYPE = 28 AND VC.VIEW_ID = V.VIEW_ID AND VC.DB_ID = V.DB_ID AND VC.COL_NO = BIT_AND(A.OBJECT_ID, 1023)
LEFT JOIN ${catalog}_SCHEMAS VS ON V.SCHEMA_ID = VS.SCHEMA_ID AND V.DB_ID = VS.DB_ID
WHERE A.DB_ID = CURRENT_DB_ID AND A.GRANTEE_ID IN (${ids.join(", ")}) AND A.OBJECT_TYPE IN (6, 28) AND A.OBJECT_ID > 0
ORDER BY A.GRANTEE_ID, A.OBJECT_ID, A.OBJECT_TYPE;`;
}

export function xuguEnrichAclColumnTargets(aclRows: XuguAclRow[], result: QueryResult): XuguAclRow[] {
  const index = findColumns(result.columns);
  const granteeIndex = index("GRANTEE_ID");
  const objectIndex = index("OBJECT_ID");
  const typeIndex = index("OBJECT_TYPE");
  const targetIndex = index("TARGET_NAME");
  if ([granteeIndex, objectIndex, typeIndex, targetIndex].some((column) => column < 0)) return aclRows;
  const targets = new Map<string, string>();
  for (const row of result.rows) {
    const granteeId = String(row[granteeIndex] ?? "");
    const objectId = String(row[objectIndex] ?? "");
    const objectType = String(row[typeIndex] ?? "");
    const target = String(row[targetIndex] ?? "").trim();
    if (granteeId && objectId && (objectType === "6" || objectType === "28") && target && !/^Column object ID\s/i.test(target)) {
      targets.set(`${granteeId}:${objectId}:${objectType}`, target);
    }
  }
  return aclRows.map((row) => ({ ...row, target: targets.get(`${row.granteeId}:${row.objectId}:${row.objectType}`) ?? row.target }));
}

export function parseXuguPrincipals(result: QueryResult, isRole: boolean): XuguPrincipal[] {
  const index = findColumns(result.columns);
  const id = index("USER_ID");
  const name = index("USER_NAME");
  if (id < 0 || name < 0) return [];
  return result.rows.flatMap((row) => {
    const principalName = String(row[name] ?? "");
    if (!principalName) return [];
    const value = (column: string) => (index(column) < 0 ? undefined : row[index(column)]);
    return [
      {
        id: String(row[id] ?? ""),
        name: principalName,
        isRole,
        locked: !isRole && asBoolean(value("LOCKED")),
        expired: !isRole && asBoolean(value("EXPIRED")),
        isSystem: asBoolean(value("IS_SYS")),
        validUntil: optionalString(value("UNTIL_TIME")),
        alias: optionalString(value("ALIAS")),
      },
    ];
  });
}

export function parseXuguMemberships(result: QueryResult): Array<{ userId: string; roleId: string }> {
  const index = findColumns(result.columns);
  const userId = index("USER_ID");
  const roleId = index("ROLE_ID");
  if (userId < 0 || roleId < 0) return [];
  return result.rows.map((row) => ({ userId: String(row[userId] ?? ""), roleId: String(row[roleId] ?? "") }));
}

export function parseXuguAclRows(result: QueryResult, principals: XuguPrincipal[], selectedId: string, systemDatabase = false): XuguAclRow[] {
  const index = findColumns(result.columns);
  const principalById = new Map(principals.map((principal) => [principal.id, principal]));
  const field = (row: unknown[], name: string, fallback = "") => (index(name) < 0 ? fallback : String(row[index(name)] ?? fallback));
  return result.rows.flatMap((row) => {
    const granteeId = field(row, "GRANTEE_ID");
    const objectId = field(row, "OBJECT_ID");
    const objectType = Number(field(row, "OBJECT_TYPE", "0"));
    const authority = field(row, "AUTHORITY", "0");
    const regrant = asBoolean(index("REGRANT") < 0 ? "0" : row[index("REGRANT")]);
    const targetPrincipal = principalById.get(granteeId);
    const systemWideDatabasePrivilege = systemDatabase && objectId === "0" && objectType === 1;
    const scope = objectId === "0" ? (systemWideDatabasePrivilege ? "system" : "database") : objectId.startsWith("-") || objectType === 4 ? "schema" : objectType === 6 || objectType === 28 ? "column" : "object";
    const schemaId = objectId.startsWith("-") ? objectId.slice(1) : objectId;
    const target =
      scope === "system"
        ? "All databases"
        : field(row, "TARGET_NAME", scope === "database" ? "Current database" : scope === "schema" ? `Schema ID ${schemaId}` : scope === "object" ? `${OBJECT_TYPE_LABELS.get(objectType) ?? `Object type ${objectType}`} ID ${objectId}` : `Column object ID ${objectId}`);
    return [{ grantorId: field(row, "GRANTOR_ID"), granteeId, objectId, objectType, authority, regrant, target, scope, inheritedFrom: granteeId !== selectedId ? targetPrincipal?.name : undefined }];
  });
}

export function xuguInheritedRoleIds(principalId: string, memberships: Array<{ userId: string; roleId: string }>): string[] {
  const byMember = new Map<string, string[]>();
  for (const membership of memberships) {
    const current = byMember.get(membership.userId) ?? [];
    current.push(membership.roleId);
    byMember.set(membership.userId, current);
  }
  const found = new Set<string>();
  const pending = [...(byMember.get(principalId) ?? [])];
  while (pending.length > 0) {
    const roleId = pending.pop()!;
    if (found.has(roleId) || roleId === principalId) continue;
    found.add(roleId);
    pending.push(...(byMember.get(roleId) ?? []));
  }
  return [...found];
}

export function xuguPrivilegesForScope(scope: XuguPrivilegeScope, objectType?: string, systemDatabase = false): XuguPrivilege[] {
  if (scope === "system") return systemDatabase ? SYSTEM_DATABASE_PRIVILEGES : [];
  if (scope === "database") return DATABASE_PRIVILEGES;
  if (scope === "schema") return SCHEMA_PRIVILEGES;
  if (scope === "object" || scope === "column") {
    const type = scope === "column" ? 6 : XUGU_OBJECT_TYPES.find((item) => item.sql === objectType)?.type;
    const privileges = (type ? OBJECT_PRIVILEGES[type] : undefined)?.map(([name, authorityBit]) => ({ name, authorityType: type!, authorityBit })) ?? [];
    if (scope !== "object" || privileges.length === 0) return privileges;
    const allPrivilegesMask = privileges.reduce((mask, privilege) => mask | privilege.authorityBit, 0);
    return [...privileges, { name: "ALL PRIVILEGES", authorityType: type!, authorityBit: allPrivilegesMask }];
  }
  return [];
}

export function decodeXuguAuthority(authority: string | number, objectType: number, scope: XuguAclRow["scope"]): string[] {
  let bits: bigint;
  try {
    bits = BigInt(authority);
  } catch {
    return [];
  }
  if (scope === "system" || scope === "database" || scope === "schema") {
    bits = BigInt.asUintN(32, bits);
    const labels = new Set<string>();
    if (objectType === 0) {
      if ((bits & BigInt(DB_ACL.DBO)) === BigInt(DB_ACL.DBO)) return ["DBO"];
      if ((bits & BigInt(DB_ACL.DBA)) === BigInt(DB_ACL.DBA)) return ["DBA"];
      if ((bits & BigInt(DB_ACL.AUDIT_ADMIN)) === BigInt(DB_ACL.AUDIT_ADMIN)) return ["AUDIT_ADMIN"];
      if ((bits & BigInt(DB_ACL.AUDITOR)) === BigInt(DB_ACL.AUDITOR)) return ["AUDITOR"];
      if ((bits & BigInt(DB_ACL.SS_ADMIN)) === BigInt(DB_ACL.SS_ADMIN)) return ["SS_ADMIN"];
      if ((bits & BigInt(DB_ACL.SSO)) === BigInt(DB_ACL.SSO)) return ["SSO"];
    }
    // ACL_CREATE (0x80) can be stored against either the generic database
    // ACL type (0) or the database object type (1). It permits creating
    // objects in the principal's own schema and is distinct from the
    // typed CREATE ANY privileges below.
    if ((objectType === 0 || objectType === 1) && (bits & BigInt(DB_ACL.CREATE)) === BigInt(DB_ACL.CREATE)) labels.add("CREATE");
    for (const privilege of [...SYSTEM_DATABASE_PRIVILEGES, ...DATABASE_PRIVILEGES]) {
      if (privilege.authorityType === objectType && (bits & BigInt(privilege.authorityBit)) === BigInt(privilege.authorityBit)) labels.add(privilege.name);
    }
    return [...labels];
  }
  const privileges = OBJECT_PRIVILEGES[objectType] ?? [];
  return privileges.filter(([, mask]) => (bits & BigInt(mask)) === BigInt(mask)).map(([name]) => name);
}

export function xuguAclAuthorityLabels(authority: string | number, objectType: number, scope: XuguAclRow["scope"], unmappedLabel: string): string[] {
  const labels = decodeXuguAuthority(authority, objectType, scope);
  return labels.length > 0 ? labels : [`${unmappedLabel} (${String(authority)})`];
}

function normalizeValidUntil(value: string): string {
  const normalized = value.trim().replace("T", " ");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) throw new Error("Enter a valid date or date and time.");
  const [, yearText, monthText, dayText, hourText = "0", minuteText = "0", secondText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(year, month, 0).getDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) throw new Error("Enter a valid date or date and time.");
  return normalized;
}

export function xuguCreatePrincipalSql(name: string, isRole: boolean, password = "", options: XuguCreateUserOptions = {}): string {
  const principal = xuguQuoteIdentifier(name);
  if (isRole) return `CREATE ROLE ${principal};`;
  const clauses = [`CREATE USER ${principal} IDENTIFIED BY ${xuguQuoteLiteral(password)}`];
  const roleNames = new Map<string, string>();
  for (const role of options.defaultRoles ?? []) {
    const normalizedRole = role.trim();
    if (normalizedRole && !roleNames.has(normalizedRole.toLocaleUpperCase())) roleNames.set(normalizedRole.toLocaleUpperCase(), normalizedRole);
  }
  const defaultRoles = [...roleNames.values()];
  if (defaultRoles.length) clauses.push(`DEFAULT ROLE ${defaultRoles.map(xuguQuoteIdentifier).join(", ")}`);
  if (options.validUntil?.trim()) clauses.push(`VALID UNTIL ${xuguQuoteLiteral(normalizeValidUntil(options.validUntil))}`);
  if (options.locked) clauses.push("ACCOUNT LOCK");
  if (options.passwordExpired) clauses.push("PASSWORD EXPIRE");
  return `${clauses.join("\n  ")};`;
}

export function xuguAlterAccountSql(principal: XuguPrincipal, options: XuguAlterAccountOptions): string {
  if (principal.isRole || isProtectedPrincipal(principal)) throw new Error("Only non-system users can have account settings changed here.");
  const clauses: string[] = [];
  if (options.validUntil?.trim()) clauses.push(`VALID UNTIL ${xuguQuoteLiteral(normalizeValidUntil(options.validUntil))}`);
  if (options.passwordExpired) clauses.push("PASSWORD EXPIRE");
  if (clauses.length === 0) throw new Error("Set a validity date or mark the password as expired.");
  return `ALTER USER ${xuguQuoteIdentifier(principal.name)}\n  ${clauses.join("\n  ")};`;
}

export function xuguAlterPasswordSql(principal: XuguPrincipal, password: string): string {
  if (principal.isRole || isProtectedPrincipal(principal)) throw new Error("Password changes are only allowed for non-system users.");
  return `ALTER USER ${xuguQuoteIdentifier(principal.name)} IDENTIFIED BY ${xuguQuoteLiteral(password)};`;
}

export function xuguAlterLockSql(principal: XuguPrincipal, locked: boolean): string {
  if (principal.isRole || isProtectedPrincipal(principal)) throw new Error("Only non-system users can be locked or unlocked here.");
  return `ALTER USER ${xuguQuoteIdentifier(principal.name)} ACCOUNT ${locked ? "LOCK" : "UNLOCK"};`;
}

export function xuguDropPrincipalSql(principal: XuguPrincipal): string {
  if (isProtectedPrincipal(principal)) {
    throw new Error("Built-in or system principals cannot be dropped from this screen.");
  }
  return `DROP ${principal.isRole ? "ROLE" : "USER"} ${xuguQuoteIdentifier(principal.name)}${principal.isRole ? "" : " RESTRICT"};`;
}

function isProtectedPrincipal(principal: XuguPrincipal): boolean {
  return principal.isSystem || ["SYS", "SYSTEM", "SYSDBA", "SYSAUDITOR", "SYSSSO", "GUEST", "PUBLIC", "DB_ADMIN", "DB_AUDIT_ADMIN", "DB_AUDIT_OPER", "DB_POLICY_ADMIN", "DB_POLICY_OPER"].includes(principal.name.trim().toUpperCase());
}

export function xuguPrincipalIsProtected(principal: XuguPrincipal): boolean {
  return isProtectedPrincipal(principal);
}

export function xuguGrantSql(input: XuguGrantInput): string {
  if (isProtectedPrincipal(input.principal)) throw new Error("Built-in or system principals cannot be modified from this screen.");
  const grantee = xuguQuoteIdentifier(input.principal.name);
  if (input.revokeGrantOptionOnly) throw new Error("Use revoke to remove a grant option.");
  if (input.scope === "admin") {
    const authority = input.adminAuthority;
    if (!authority) throw new Error("Choose an administrative authority.");
    return `GRANT ${authority} TO ${grantee};`;
  }
  if (input.scope === "role") {
    if (input.principal.isRole) throw new Error("Roles can only be granted to users.");
    const role = xuguQuoteIdentifier(input.role ?? "");
    return `GRANT ROLE ${role} TO ${grantee};`;
  }
  if (input.scope === "system" && !input.systemDatabase) throw new Error("System database privileges can only be managed from the SYSTEM database.");
  if (input.scope === "object" && !XUGU_OBJECT_TYPES.some((item) => item.sql === input.objectType)) throw new Error("Choose a supported object type.");
  if (input.scope === "column" && !["TABLE", "VIEW"].includes(input.objectType ?? "")) throw new Error("Column grants are supported only for tables and views.");
  const privileges = [...new Set((input.privileges ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (privileges.length === 0) throw new Error("Choose at least one privilege.");
  if (input.scope === "object" && privileges.includes("ALL PRIVILEGES") && privileges.length > 1) throw new Error("ALL PRIVILEGES cannot be combined with individual privileges.");
  const supportedPrivileges = new Set(xuguPrivilegesForScope(input.scope, input.objectType, input.systemDatabase).map((item) => item.name));
  if (privileges.some((privilege) => !supportedPrivileges.has(privilege))) throw new Error("One or more privileges are not valid for this scope.");
  if (input.grantOption && input.scope !== "object") {
    throw new Error("WITH GRANT OPTION is supported only for object-level privileges.");
  }
  if (input.scope === "system" || input.scope === "database") {
    if (input.grantOption) throw new Error("Xugu does not support grant option for database-level privileges.");
    return `GRANT ${privileges.join(", ")} TO ${grantee};`;
  }
  if (input.scope === "schema") {
    const schema = xuguQuoteIdentifier(input.schema ?? "");
    return `GRANT ${privileges.join(", ")} IN SCHEMA ${schema} TO ${grantee}${input.grantOption ? " WITH GRANT OPTION" : ""};`;
  }
  const schema = xuguQuoteIdentifier(input.schema ?? "");
  const object = xuguQuoteIdentifier(input.object ?? "");
  if (input.scope === "column") {
    const column = xuguQuoteIdentifier(input.column ?? "");
    const privilege = privileges[0];
    if (privileges.length !== 1 || !["SELECT", "UPDATE"].includes(privilege)) throw new Error("Column grants support SELECT or UPDATE, one privilege at a time.");
    return `GRANT ${privilege} (${column}) ON ${schema}.${object} TO ${grantee}${input.grantOption ? " WITH GRANT OPTION" : ""};`;
  }
  const objectType = XUGU_OBJECT_TYPES.find((item) => item.sql === input.objectType);
  if (!objectType) throw new Error("Choose a supported object type.");
  const objectTypeClause = ["TABLE", "VIEW", "PROCEDURE", "SEQUENCE"].includes(objectType.sql) ? `${objectType.sql} ` : "";
  return `GRANT ${privileges.join(", ")} ON ${objectTypeClause}${schema}.${object} TO ${grantee}${input.grantOption ? " WITH GRANT OPTION" : ""};`;
}

export function xuguRevokeSql(input: XuguGrantInput): string {
  if (isProtectedPrincipal(input.principal)) throw new Error("Built-in or system principals cannot be modified from this screen.");
  const grantee = xuguQuoteIdentifier(input.principal.name);
  if (input.scope === "admin") {
    if (!input.adminAuthority) throw new Error("Choose an administrative authority.");
    return `REVOKE ${input.adminAuthority} FROM ${grantee};`;
  }
  if (input.scope === "role") {
    if (input.principal.isRole) throw new Error("Roles can only be revoked from users.");
    return `REVOKE ROLE ${xuguQuoteIdentifier(input.role ?? "")} FROM ${grantee};`;
  }
  if (input.scope === "system" && !input.systemDatabase) throw new Error("System database privileges can only be managed from the SYSTEM database.");
  if (input.scope === "object" && !XUGU_OBJECT_TYPES.some((item) => item.sql === input.objectType)) throw new Error("Choose a supported object type.");
  if (input.scope === "column" && !["TABLE", "VIEW"].includes(input.objectType ?? "")) throw new Error("Column grants are supported only for tables and views.");
  const privileges = [...new Set((input.privileges ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (privileges.length === 0) throw new Error("Choose at least one privilege.");
  if (input.scope === "object" && privileges.includes("ALL PRIVILEGES") && privileges.length > 1) throw new Error("ALL PRIVILEGES cannot be combined with individual privileges.");
  const supportedPrivileges = new Set(xuguPrivilegesForScope(input.scope, input.objectType, input.systemDatabase).map((item) => item.name));
  if (privileges.some((privilege) => !supportedPrivileges.has(privilege))) throw new Error("One or more privileges are not valid for this scope.");
  const grantOption = input.revokeGrantOptionOnly ? " GRANT OPTION FOR" : "";
  if (input.revokeGrantOptionOnly && input.scope !== "object") {
    throw new Error("WITH GRANT OPTION is supported only for object-level privileges.");
  }
  const suffix = input.scope === "database" || input.scope === "system" ? "" : input.scope === "schema" ? ` IN SCHEMA ${xuguQuoteIdentifier(input.schema ?? "")}` : ` ${xuguQuoteIdentifier(input.schema ?? "")}.${xuguQuoteIdentifier(input.object ?? "")}`;
  if (input.scope === "column") {
    const column = xuguQuoteIdentifier(input.column ?? "");
    const privilege = privileges[0];
    if (privileges.length !== 1 || !["SELECT", "UPDATE"].includes(privilege)) throw new Error("Column grants support SELECT or UPDATE, one privilege at a time.");
    return `REVOKE${grantOption} ${privilege} (${column}) ON ${xuguQuoteIdentifier(input.schema ?? "")}.${xuguQuoteIdentifier(input.object ?? "")} FROM ${grantee};`;
  }
  const objectSuffix = input.scope === "object" ? ` ON${suffix}` : suffix;
  if (input.scope === "object") {
    const objectType = XUGU_OBJECT_TYPES.find((item) => item.sql === input.objectType);
    if (!objectType) throw new Error("Choose a supported object type.");
    const objectTypeClause = ["TABLE", "VIEW", "PROCEDURE", "SEQUENCE"].includes(objectType.sql) ? ` ${objectType.sql}` : "";
    return `REVOKE${grantOption} ${privileges.join(", ")} ON${objectTypeClause}${suffix} FROM ${grantee};`;
  }
  return `REVOKE${grantOption} ${privileges.join(", ")}${objectSuffix} FROM ${grantee};`;
}

function findColumns(columns: string[]) {
  const normalized = columns.map((column) => column.toLowerCase());
  return (name: string) => normalized.indexOf(name.toLowerCase());
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["1", "t", "true", "y", "yes"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function optionalString(value: unknown): string | undefined {
  if (value == null || String(value).trim() === "" || String(value).toUpperCase() === "NULL") return undefined;
  return String(value);
}

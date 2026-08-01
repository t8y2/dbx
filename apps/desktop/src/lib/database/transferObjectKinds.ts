import type { DatabaseType } from "@/types/database";

export enum TransferObjectFamily {
  Mysql = "mysql",
  Postgres = "postgres",
  Oracle = "oracle",
  SqlServer = "sqlserver",
}

export type TransferObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "EVENT";

const MYSQL_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"];
const POSTGRES_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"];
const ORACLE_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"];
const SQLSERVER_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"];

const FAMILY_BY_DB = new Map<DatabaseType, TransferObjectFamily>([
  ["mysql", TransferObjectFamily.Mysql],
  ["postgres", TransferObjectFamily.Postgres],
  ["kingbase", TransferObjectFamily.Postgres],
  ["gaussdb", TransferObjectFamily.Postgres],
  ["kwdb", TransferObjectFamily.Postgres],
  ["opengauss", TransferObjectFamily.Postgres],
  ["oracle", TransferObjectFamily.Oracle],
  ["dameng", TransferObjectFamily.Oracle],
  ["oceanbase-oracle", TransferObjectFamily.Oracle],
  ["sqlserver", TransferObjectFamily.SqlServer],
]);

export function transferObjectFamily(dbType?: DatabaseType): TransferObjectFamily | undefined {
  return dbType ? FAMILY_BY_DB.get(dbType) : undefined;
}

export function isSameTransferFamily(a?: DatabaseType, b?: DatabaseType): boolean {
  const fa = transferObjectFamily(a);
  const fb = transferObjectFamily(b);
  return !!fa && fa === fb;
}

export function transferObjectKindsForDatabase(dbType?: DatabaseType): TransferObjectKind[] {
  switch (transferObjectFamily(dbType)) {
    case TransferObjectFamily.Mysql:
      return [...MYSQL_KINDS];
    case TransferObjectFamily.Postgres:
      return [...POSTGRES_KINDS];
    case TransferObjectFamily.Oracle:
      return [...ORACLE_KINDS];
    case TransferObjectFamily.SqlServer:
      return [...SQLSERVER_KINDS];
    default:
      return [];
  }
}

/**
 * Kinds selectable for a transfer between the two databases. Within one
 * family every kind of the source is allowed; across families only
 * mechanically rewriteable kinds (views, sequences) are allowed, and
 * sequences additionally require both sides to support the type.
 */
export function crossFamilyTransferableKinds(a?: DatabaseType, b?: DatabaseType): TransferObjectKind[] {
  if (isSameTransferFamily(a, b)) {
    return transferObjectKindsForDatabase(a);
  }
  const aKinds = transferObjectKindsForDatabase(a);
  const bKinds = transferObjectKindsForDatabase(b);
  const allowed: TransferObjectKind[] = [];
  if (aKinds.includes("VIEW") && bKinds.includes("VIEW")) allowed.push("VIEW");
  if (aKinds.includes("SEQUENCE") && bKinds.includes("SEQUENCE")) allowed.push("SEQUENCE");
  return allowed;
}

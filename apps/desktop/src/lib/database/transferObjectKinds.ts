import type { DatabaseType } from "@/types/database";
import { supportsTransfer } from "@/lib/database/databaseFeatureSupport";

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
      return supportsTransfer(dbType) ? ["TABLE"] : [];
  }
}

/**
 * Kinds selectable for a transfer between the two databases. Within one
 * family every kind of the source is allowed; across families only
 * sequences are allowed (plain DDL without a query body), and only when
 * both sides support the type. Views are excluded: the backend rewrites
 * only the DDL wrapper, quoting and schema qualifiers, not the view
 * query body, so cross-family view bodies could run unchanged on an
 * incompatible target.
 */
export function crossFamilyTransferableKinds(a?: DatabaseType, b?: DatabaseType): TransferObjectKind[] {
  if (isSameTransferFamily(a, b)) {
    return transferObjectKindsForDatabase(a);
  }
  const aFam = transferObjectFamily(a);
  const bFam = transferObjectFamily(b);
  // Cross-family DDL conversion is only implemented and validated for
  // MySQL / SQL Server / Oracle families. Postgres-family sources or
  // targets (postgres/kingbase/gaussdb/kwdb/opengauss) are not supported
  // by the cross-family executor, so nothing is selectable there.
  const supported = new Set([TransferObjectFamily.Mysql, TransferObjectFamily.SqlServer, TransferObjectFamily.Oracle]);
  if (!aFam || !bFam || !supported.has(aFam) || !supported.has(bFam)) return [];
  const aKinds = transferObjectKindsForDatabase(a);
  const bKinds = transferObjectKindsForDatabase(b);
  // Cross-family VIEW transfer is disabled: the backend only rewrites the
  // DDL wrapper/quoting/schema qualifiers and cannot translate the view
  // query body (IFNULL, TOP, GETDATE, … would run unchanged on an
  // incompatible target). Sequences are plain DDL and remain transferable
  // when both sides support them.
  const allowed: TransferObjectKind[] = [];
  if (aKinds.includes("SEQUENCE") && bKinds.includes("SEQUENCE")) allowed.push("SEQUENCE");
  return allowed;
}

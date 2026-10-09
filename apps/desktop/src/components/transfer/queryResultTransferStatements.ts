import type { DatabaseType } from "@/types/database";
import { queryResultTransferSqlLiteral } from "./queryResultTransferValues";

/** Keep the Oracle multi-row form in sync with data/transfer.rs::InsertSqlTemplate. */
export function queryResultTransferInsertSql(table: string, columns: string[], values: string[], databaseType: DatabaseType, overrideIdentity = false): string[] {
  if (!values.length) return [];
  const destination = `${table} (${columns.join(", ")})`;
  if ((databaseType === "oracle" || databaseType === "oceanbase-oracle") && values.length > 1) {
    return [`INSERT ALL\n${values.map((row) => `INTO ${destination} VALUES ${row}`).join("\n")}\nSELECT 1 FROM dual`];
  }
  const override = overrideIdentity ? " OVERRIDING SYSTEM VALUE" : "";
  // Single-row statements also work on JDBC engines without comma-separated VALUES.
  if (!["mysql", "postgres", "sqlite", "sqlserver", "h2", "kingbase", "highgo", "vastbase", "goldendb"].includes(databaseType)) {
    return values.map((row) => `INSERT INTO ${destination}${override} VALUES ${row}`);
  }
  return [`INSERT INTO ${destination}${override} VALUES ${values.join(",\n")}`];
}

/** IDENTITY_INSERT is session state: restore it on both the success and error paths. */
export function withSqlServerIdentityInsert(table: string, statements: string[]): string {
  return `BEGIN TRY\nSET IDENTITY_INSERT ${table} ON;\n${statements.join(";\n")};\nSET IDENTITY_INSERT ${table} OFF;\nEND TRY\nBEGIN CATCH\nDECLARE @dbx_transfer_error nvarchar(2048);\nSET @dbx_transfer_error = ERROR_MESSAGE();\nSET IDENTITY_INSERT ${table} OFF;\nRAISERROR(N'%s', 16, 1, @dbx_transfer_error);\nEND CATCH`;
}

/**
 * Advance an owned PostgreSQL sequence without moving it backwards or changing
 * its increment grid. ALTER SEQUENCE locks concurrent nextval calls; RESTART is
 * transactional on PostgreSQL 10+, unlike setval. The catalog branch preserves
 * compatibility with older SERIAL-only servers.
 * https://www.postgresql.org/docs/current/sql-altersequence.html
 * https://www.postgresql.org/docs/9.6/sql-altersequence.html
 */
export function postgresTransferSequenceSyncSql(table: string, column: string): string {
  const literal = (value: string) => queryResultTransferSqlLiteral(value, "postgres")!;
  const quotedColumn = '"' + column.replaceAll('"', '""') + '"';
  const body = `DECLARE
  dbx_sequence regclass;
  dbx_increment bigint;
  dbx_last numeric;
  dbx_called boolean;
  dbx_next numeric;
  dbx_edge numeric;
  dbx_restart numeric;
BEGIN
  dbx_sequence := pg_catalog.pg_get_serial_sequence(${literal(table)}, ${literal(column)})::regclass;
  IF dbx_sequence IS NULL THEN
    RAISE EXCEPTION 'Unable to find the owned identity/serial sequence';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_sequence') THEN
    EXECUTE 'SELECT seqincrement FROM pg_catalog.pg_sequence WHERE seqrelid = $1' INTO dbx_increment USING dbx_sequence;
  ELSE
    EXECUTE 'SELECT increment_by FROM ' || dbx_sequence::text INTO dbx_increment;
  END IF;
  IF dbx_increment IS NULL OR dbx_increment = 0 THEN
    RAISE EXCEPTION 'Unable to read the identity/serial sequence increment';
  END IF;
  EXECUTE 'ALTER SEQUENCE ' || dbx_sequence::text || ' INCREMENT BY ' || dbx_increment::text;
  EXECUTE 'SELECT last_value, is_called FROM ' || dbx_sequence::text INTO dbx_last, dbx_called;
  EXECUTE 'SELECT ' || CASE WHEN dbx_increment > 0 THEN 'MAX' ELSE 'MIN' END || ${literal(`(${quotedColumn}::numeric) FROM ${table}`)} INTO dbx_edge;
  dbx_next := dbx_last + CASE WHEN dbx_called THEN dbx_increment ELSE 0 END;
  IF (dbx_increment > 0 AND dbx_edge >= dbx_next) OR (dbx_increment < 0 AND dbx_edge <= dbx_next) THEN
    dbx_restart := dbx_next + FLOOR((dbx_edge - dbx_next) / dbx_increment) * dbx_increment;
    EXECUTE 'ALTER SEQUENCE ' || dbx_sequence::text || ' RESTART WITH ' || dbx_restart::text;
    PERFORM pg_catalog.nextval(dbx_sequence);
  END IF;
END;`;
  let delimiter = "$dbx_transfer$";
  while (body.includes(delimiter)) delimiter = delimiter.slice(0, -1) + "_$";
  return `DO ${delimiter}\n${body}\n${delimiter}`;
}

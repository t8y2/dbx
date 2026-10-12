// Native Dameng dexp/dimp (.dmp) dump — request/progress shapes shared by the
// Tauri and HTTP backends. Field names mirror the Rust `DamengDumpTaskRequest`
// / `DamengDumpProgress` (serde camelCase).

export type DamengDumpKind = "export" | "import";

export interface DamengDumpRequest {
  taskId: string;
  connectionId: string;
  kind: DamengDumpKind;
  /** Absolute path to the dexp/dimp executable (from the client bin setting). */
  toolPath: string;
  /** `.dmp` file to write (export) or read (import). */
  filePath: string;
  /** Schemas to export/import; empty means whole-database. */
  schemas: string[];
  /** Explicit tables (export only); empty means the whole schema. */
  tables: string[];
  /** Import only: REMAP_SCHEMA=SRC:DST. */
  remapSchema: [string, string] | null;
  /** Import only: TABLE_EXISTS_ACTION=SKIP|REPLACE|TRUNCATE|APPEND. */
  tableExistsAction: string | null;
}

export type DamengDumpStatus = "running" | "done" | "error" | "cancelled";

export interface DamengDumpProgress {
  taskId: string;
  status: DamengDumpStatus;
  success: boolean;
  warnings: boolean;
  elapsedSeconds: string | null;
  error: string | null;
}

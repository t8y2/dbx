import type { SqlCompletionScope } from "@/lib/sql/sqlCompletionLookupTarget";
import type { DatabaseType } from "@/types/database";
import type { CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import type { StatementExecutionMarker } from "@/lib/tabs/tabPresentation";

export interface QueryEditorProps {
  modelValue: string;
  /** Identity of the tab owning the document. Changing it swaps in that tab's cached editor state (fresh undo history on first visit). */
  tabId?: string;
  connectionId?: string;
  catalog?: string;
  database?: string;
  schema?: string;
  clientSessionId?: string;
  completionContextVersion?: number;
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver";
  syntaxDialect?: CodeMirrorSqlDialectName;
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  compressRequestId?: number;
  executionError?: string;
  executionErrorSql?: string;
  resultColumns?: string[];
  resultSourceStatement?: string;
  resultSourceFrom?: number;
  resultSourceTo?: number;
  readOnly?: boolean;
  autoFocus?: boolean;
  forceWordWrap?: boolean;
  hideExecutionControls?: boolean;
  enableExplainShortcut?: boolean;
  canExplain?: boolean;
  initialViewport?: { scrollTop: number; scrollLeft: number };
  initialSelection?: { anchor: number; head: number };
  revealRequest?: { id: number; line: number; column?: number };
  statementExecutionMarkers?: StatementExecutionMarker[];
}

export type CompletionMetadataScope = Pick<SqlCompletionScope, "database" | "schema">;

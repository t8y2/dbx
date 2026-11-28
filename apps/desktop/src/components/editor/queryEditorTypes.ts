import type { SqlCompletionScope } from "@/lib/sql/sqlCompletionLookupTarget";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import type { StatementExecutionMarker } from "@/lib/tabs/tabPresentation";
import type { MongoQueryLanguage } from "@/lib/mongo/mongoSql";
import type { OraclePackageSourceContext } from "@/lib/sql/oraclePackageMemberNavigation";

export interface QueryEditorProps {
  modelValue: string;
  /** Identity of the tab owning the document. Changing it swaps in that tab's cached editor state (fresh undo history on first visit). */
  tabId?: string;
  bookmarkLines?: number[];
  /** When present, identifies the document these persisted lines already map to. */
  bookmarkDocument?: string;
  connectionId?: string;
  catalog?: string;
  database?: string;
  /** Warm table metadata for the active database; only query tabs enable this. */
  prefetchCompletion?: boolean;
  schema?: string;
  /** 这份文档是某个 Oracle 包的源码时的包身份；包内名字优先在包里解析，而不是当成独立过程。 */
  packageSource?: OraclePackageSourceContext;
  debugRoutine?: { schema?: string; name: string; objectType: "PROCEDURE" | "FUNCTION" };
  clientSessionId?: string;
  completionContextVersion?: number;
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver";
  syntaxDialect?: CodeMirrorSqlDialectName;
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  compressRequestId?: number;
  /** Toolbar `a`/`A`: convert keywords in place, matching `keywordCaseRequestMode`. */
  keywordCaseRequestId?: number;
  keywordCaseRequestMode?: "upper" | "lower";
  executionError?: string;
  executionErrorSql?: string;
  executionErrorResult?: QueryResult;
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
  isExecuting?: boolean;
  initialViewport?: { scrollTop: number; scrollLeft: number };
  initialSelection?: { anchor: number; head: number };
  revealRequest?: { id: number; line: number; column?: number };
  statementExecutionMarkers?: StatementExecutionMarker[];
  /** MongoDB query tabs: SQL mode uses the SQL statement splitter and formatter. */
  mongoQueryLanguage?: MongoQueryLanguage;
}

export type CompletionMetadataScope = Pick<SqlCompletionScope, "database" | "schema">;

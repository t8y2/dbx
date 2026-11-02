import * as api from "@/lib/backend/api";
import { isSchemaAware, isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import { analyzeEditableQuery } from "@/lib/sql/sqlAnalysis";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { DatabaseType } from "@/types/database";
import { queryResultTransferSqlLiteral } from "./queryResultTransferValues";

const POSTGRES_SOURCE_TYPES = new Set<DatabaseType>(["postgres", "kingbase", "highgo", "vastbase"]);
const ORACLE_SOURCE_TYPES = new Set<DatabaseType>(["oracle", "oceanbase-oracle", "dameng", "yashandb"]);

export interface QueryResultTransferSourceDdlRequest {
  sql: string;
  databaseType?: DatabaseType;
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  clientSessionId?: string;
  txnSessionId?: string;
}

/** Read one executable table definition, without display-only access statements. */
export async function loadQueryResultTransferSourceDdl(request: QueryResultTransferSourceDdlRequest): Promise<string | undefined> {
  // Metadata APIs do not participate in the separate manual transaction.
  // A complete row snapshot is usable, but its uncommitted DDL is not.
  if (!request.connectionId || !request.database || request.txnSessionId) return undefined;
  const analysis = analyzeEditableQuery(request.sql);
  if (!analysis?.selectStar || analysis.sources?.length) return undefined;

  const fold = (name: string, quoted?: boolean) => {
    if (quoted || !request.databaseType) return name;
    if (POSTGRES_SOURCE_TYPES.has(request.databaseType)) return name.toLowerCase();
    if (ORACLE_SOURCE_TYPES.has(request.databaseType)) return name.toUpperCase();
    return name;
  };
  let table = fold(analysis.tableName, analysis.tableNameQuoted);
  let database = request.database;
  let schema = analysis.schema ? fold(analysis.schema, analysis.schemaQuoted) : request.schema;
  let catalog = analysis.catalog ?? request.catalog;
  if (!isSchemaAware(request.databaseType) && !isSingleDatabase(request.databaseType)) {
    if (analysis.schema && !analysis.catalog) database = analysis.schema;
    // MySQL metadata prefers its schema argument over database. A prior query
    // schema must not override an explicitly qualified source database.
    schema = database;
    catalog = request.catalog;
  }
  try {
    const readOnSourceSession = async (sql: string, querySchema?: string) => {
      const results = await api.executeMulti(request.connectionId, request.database, sql, querySchema, undefined, {
        executionMode: "simple",
        maxRows: 10000,
        catalog: request.catalog,
        clientSessionId: request.clientSessionId,
      });
      const result = results[0];
      return results.length === 1 && result && !result.execution_error && !result.truncated && !result.has_more && !result.large_value_cells?.length ? result : undefined;
    };
    if (request.databaseType === "mysql" || request.databaseType === "goldendb") {
      // Temporary MySQL tables shadow same-named permanent tables even when
      // qualified. SHOW CREATE must run on the session that produced the rows.
      const quote = (name: string) => "`" + name.replaceAll("`", "``") + "`";
      const result = await readOnSourceSession(`SHOW CREATE TABLE ${quote(database)}.${quote(table)}`);
      const ddl = result?.rows[0]?.[1];
      if (result?.rows.length !== 1 || typeof ddl !== "string" || !ddl.trim()) return undefined;
      const tokens = tokenizeSqlSemantic(ddl, "mysql", { mysqlBackslashEscape: true, mysqlDashCommentRequiresWhitespace: true }).filter((token) => token.kind !== "comment");
      // A target temporary table would disappear on another pooled connection;
      // do not silently change its lifetime or read a permanent shadow instead.
      if (tokens[0]?.normalized === "create" && tokens[1]?.normalized === "temporary") return undefined;
      return ddl;
    }
    if (request.databaseType === "sqlite") {
      const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
      const literal = (name: string) => queryResultTransferSqlLiteral(name, "sqlite")!;
      let namespaces: string[];
      if (analysis.schema) namespaces = [analysis.schema];
      else {
        const databases = await readOnSourceSession("PRAGMA database_list");
        if (!databases || databases.rows.some((row) => typeof row[0] !== "number" || typeof row[1] !== "string")) return undefined;
        // SQLite resolves bare names in temp, main, then attachment order;
        // selecting a sidebar database does not change this SQL lookup order.
        namespaces = [...new Set(["temp", "main", ...[...databases.rows].sort((left, right) => Number(left[0]) - Number(right[0])).map((row) => row[1] as string)])];
      }
      for (const namespace of namespaces) {
        const master = `${quote(namespace)}.sqlite_master`;
        const definitions = await readOnSourceSession(`SELECT name, sql, type FROM ${master} WHERE type IN ('table', 'view') AND name = ${literal(table)} COLLATE NOCASE`);
        if (!definitions) return undefined;
        if (!definitions.rows.length) continue;
        const definition = definitions.rows[0]!;
        if (definitions.rows.length !== 1 || definition[2] !== "table" || typeof definition[0] !== "string" || typeof definition[1] !== "string" || !definition[1].trim()) return undefined;
        // Read exact index SQL, including expressions and WHERE clauses. The
        // actual table name also handles case-insensitive SQLite name lookup.
        const indexes = await readOnSourceSession(`SELECT sql FROM ${master} WHERE type = 'index' AND tbl_name = ${literal(definition[0])} COLLATE NOCASE AND sql IS NOT NULL ORDER BY name`);
        if (!indexes || indexes.rows.some((row) => typeof row[0] !== "string" || !row[0].trim())) return undefined;
        return [definition[1], ...indexes.rows.map((row) => row[0] as string)].join("\n;\n");
      }
      return undefined;
    }
    if (request.databaseType === "h2") {
      // H2 can store unquoted names in upper, lower or original case. Resolve
      // the physical metadata name without assuming DATABASE_TO_UPPER. An
      // ambiguous case-only match must not copy a different quoted table.
      const metadata = await readOnSourceSession("SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES", request.schema);
      if (!metadata || metadata.rows.some((row) => row.slice(0, 3).length !== 3 || row.slice(0, 3).some((value) => typeof value !== "string"))) return undefined;
      const uniqueName = (names: string[], name: string) => {
        const matches = [...new Set(names)].filter((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return matches.length === 1 ? matches[0] : undefined;
      };
      if (analysis.schema && !analysis.schemaQuoted) {
        schema = uniqueName(
          metadata.rows.map((row) => row[0] as string),
          analysis.schema,
        );
      }
      if (!schema) return undefined;
      const tables = metadata.rows.filter((row) => row[0] === schema && (analysis.tableNameQuoted ? row[1] === table : (row[1] as string).toLowerCase() === table.toLowerCase()));
      if (tables.length !== 1 || /TEMPORARY/i.test(tables[0]![2] as string)) return undefined;
      table = tables[0]![1] as string;
      // H2 SCRIPT implicitly commits even a user-typed BEGIN. Once this
      // source session proves the physical table is permanent, use the
      // independent metadata connection for SCRIPT through getTableDdl.
    }
    if (request.databaseType && POSTGRES_SOURCE_TYPES.has(request.databaseType) && !analysis.schema) {
      // current_schema() alone can select the first search_path entry even
      // when the queried table lives in a later one. Resolve this relation on
      // the source query session instead of guessing public or the DB name.
      const relation = '"' + table.replaceAll('"', '""') + '"';
      const literal = queryResultTransferSqlLiteral(relation, "postgres");
      const results = await api.executeMulti(request.connectionId, database, `SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = pg_catalog.to_regclass(${literal}) AND c.relkind IN ('r', 'p', 'f')`, request.schema, undefined, {
        executionMode: "simple",
        maxRows: 1,
        catalog,
        clientSessionId: request.clientSessionId,
      });
      const resolvedSchema = results[0]?.rows[0]?.[0];
      if (results.some((result) => result.execution_error) || typeof resolvedSchema !== "string" || !resolvedSchema) return undefined;
      schema = resolvedSchema;
    }
    if (isSchemaAware(request.databaseType) && !schema) return undefined;
    // SQL Server's display DDL includes temporal-table metadata. The ordinary
    // renderer omits it, which would make an unsafe temporal copy look plain.
    const loadDdl = request.databaseType === "sqlserver" ? api.getTableDisplayDdl : api.getTableDdl;
    const ddl = await loadDdl(request.connectionId, database, schema || database, table, undefined, catalog);
    return ddl || undefined;
  } catch {
    return undefined;
  }
}

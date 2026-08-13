import type { QueryResult } from "@/types/database";

export const SQLSERVER_TRACE_SESSION_PREFIX = "DBX_TRACE_";
export const SQLSERVER_TRACE_INTERNAL_MARKER = "DBX_INTERNAL_TRACE";
export const SQLSERVER_TRACE_DEFAULT_MAX_EVENTS = 1000;
export const SQLSERVER_TRACE_MIN_MAX_EVENTS = 100;
export const SQLSERVER_TRACE_MAX_MAX_EVENTS = 5000;
export const SQLSERVER_TRACE_DEFAULT_DURATION_MINUTES = 10;
export const SQLSERVER_TRACE_MIN_DURATION_MINUTES = 1;
export const SQLSERVER_TRACE_MAX_DURATION_MINUTES = 60;
export const SQLSERVER_TRACE_STALE_GRACE_MINUTES = 5;
export const SQLSERVER_TRACE_RING_BUFFER_MAX_EVENTS = 256;
export const SQLSERVER_TRACE_READ_BATCH_SIZE = 256;

export interface SqlServerTraceCapabilities {
  productVersion: string;
  majorVersion: number;
  engineEdition: number;
  databaseId: number;
  canAlterEventSession: boolean;
  canViewServerState: boolean;
  canViewServerPerformanceState: boolean;
  hasRpcCompletedEvent: boolean;
  hasSqlBatchCompletedEvent: boolean;
  hasSpStatementCompletedEvent: boolean;
  hasRingBufferTarget: boolean;
  hasDatabaseIdPredicate: boolean;
  hasLikePredicate: boolean;
  availableActions: Set<string>;
}

export interface SqlServerTraceEvent {
  key: string;
  eventName: string;
  timestamp: string;
  database: string;
  sqlText: string;
  durationMs: number | null;
  cpuMs: number | null;
  logicalReads: number | null;
  writes: number | null;
  rowCount: number | null;
  sessionId: number | null;
  loginName: string;
  hostName: string;
  clientApp: string;
  result: string;
}

export interface SqlServerTraceSessionOptions {
  sessionName: string;
  databaseId: number;
  maxEvents: number;
  includeStatements: boolean;
}

type QueryCell = string | number | boolean | null;

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeSqlServerTraceMaxEvents(value: number): number {
  return clampInteger(value, SQLSERVER_TRACE_MIN_MAX_EVENTS, SQLSERVER_TRACE_MAX_MAX_EVENTS, SQLSERVER_TRACE_DEFAULT_MAX_EVENTS);
}

export function normalizeSqlServerTraceDurationMinutes(value: number): number {
  return clampInteger(value, SQLSERVER_TRACE_MIN_DURATION_MINUTES, SQLSERVER_TRACE_MAX_DURATION_MINUTES, SQLSERVER_TRACE_DEFAULT_DURATION_MINUTES);
}

export function buildSqlServerTraceSessionName(expiresAt = Date.now() + (SQLSERVER_TRACE_MAX_DURATION_MINUTES + SQLSERVER_TRACE_STALE_GRACE_MINUTES) * 60_000, random = Math.random()): string {
  const timePart = Math.max(0, Math.floor(expiresAt)).toString(36).toUpperCase();
  const randomPart = Math.max(0, Math.min(0.999999999, random)).toString(36).slice(2, 10).toUpperCase().padEnd(8, "0");
  return `${SQLSERVER_TRACE_SESSION_PREFIX}${timePart}_${randomPart}`;
}

export function isValidSqlServerTraceSessionName(value: string): boolean {
  return /^DBX_TRACE_[A-Z0-9_]{3,100}$/.test(value);
}

function assertSessionName(sessionName: string): string {
  if (!isValidSqlServerTraceSessionName(sessionName)) throw new Error("Invalid SQL Server trace session name");
  return sessionName;
}

function sqlString(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

function internalSql(sql: string): string {
  return `/* ${SQLSERVER_TRACE_INTERNAL_MARKER} */\n${sql}`;
}

export function buildSqlServerTraceCapabilitiesSql(database: string): string {
  return internalSql(`SELECT
  CAST(SERVERPROPERTY(N'ProductVersion') AS nvarchar(128)) AS product_version,
  CONVERT(int, SERVERPROPERTY(N'EngineEdition')) AS engine_edition,
  DB_ID(${sqlString(database)}) AS database_id,
  CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY EVENT SESSION')) AS can_alter_event_session,
  CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE')) AS can_view_server_state,
  CONVERT(int, CASE
    WHEN EXISTS (SELECT 1 FROM sys.fn_builtin_permissions(DEFAULT) WHERE permission_name = N'VIEW SERVER PERFORMANCE STATE')
      THEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER PERFORMANCE STATE')
    ELSE 1
  END) AS can_view_server_performance_state,
  CONVERT(int, CASE WHEN EXISTS (
    SELECT 1 FROM sys.dm_xe_objects object
    JOIN sys.dm_xe_packages package ON package.guid = object.package_guid
    WHERE package.name = N'sqlserver' AND object.object_type = N'event' AND object.name = N'rpc_completed'
  ) THEN 1 ELSE 0 END) AS has_rpc_completed_event,
  CONVERT(int, CASE WHEN EXISTS (
    SELECT 1 FROM sys.dm_xe_objects object
    JOIN sys.dm_xe_packages package ON package.guid = object.package_guid
    WHERE package.name = N'sqlserver' AND object.object_type = N'event' AND object.name = N'sql_batch_completed'
  ) THEN 1 ELSE 0 END) AS has_sql_batch_completed_event,
  CONVERT(int, CASE WHEN EXISTS (
    SELECT 1 FROM sys.dm_xe_objects object
    JOIN sys.dm_xe_packages package ON package.guid = object.package_guid
    WHERE package.name = N'sqlserver' AND object.object_type = N'event' AND object.name = N'sp_statement_completed'
  ) THEN 1 ELSE 0 END) AS has_sp_statement_completed_event,
  CONVERT(int, CASE WHEN EXISTS (
    SELECT 1 FROM sys.dm_xe_objects object
    JOIN sys.dm_xe_packages package ON package.guid = object.package_guid
    WHERE package.name = N'package0' AND object.object_type = N'target' AND object.name = N'ring_buffer'
  ) THEN 1 ELSE 0 END) AS has_ring_buffer_target,
  CONVERT(int, CASE WHEN EXISTS (
    SELECT 1 FROM sys.dm_xe_objects object
    JOIN sys.dm_xe_packages package ON package.guid = object.package_guid
    WHERE package.name = N'sqlserver' AND object.object_type = N'pred_source' AND object.name = N'database_id'
  ) THEN 1 ELSE 0 END) AS has_database_id_predicate,
  CONVERT(int, CASE WHEN EXISTS (
    SELECT 1 FROM sys.dm_xe_objects object
    JOIN sys.dm_xe_packages package ON package.guid = object.package_guid
    WHERE package.name = N'sqlserver' AND object.object_type = N'pred_compare' AND object.name = N'like_i_sql_unicode_string'
  ) THEN 1 ELSE 0 END) AS has_like_predicate,
  STUFF((
    SELECT N',' + object.name
    FROM sys.dm_xe_objects object
    JOIN sys.dm_xe_packages package ON package.guid = object.package_guid
    WHERE package.name = N'sqlserver'
      AND object.object_type = N'action'
      AND object.name IN (
        N'client_app_name', N'client_hostname', N'database_id', N'database_name',
        N'server_principal_name', N'session_id', N'sql_text'
      )
    ORDER BY object.name
    FOR XML PATH(N''), TYPE
  ).value(N'.', N'nvarchar(max)'), 1, 1, N'') AS available_actions;`);
}

function columnIndex(result: QueryResult, name: string): number {
  return result.columns.findIndex((column) => column.toLowerCase() === name.toLowerCase());
}

function cell(result: QueryResult, row: QueryCell[], name: string): QueryCell {
  const index = columnIndex(result, name);
  return index >= 0 ? row[index] : null;
}

function textValue(value: QueryCell): string {
  return value == null ? "" : String(value);
}

function numberValue(value: QueryCell): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: QueryCell): boolean {
  if (typeof value === "boolean") return value;
  return numberValue(value) === 1 || String(value).toLowerCase() === "true";
}

export function parseSqlServerTraceCapabilities(result: QueryResult): SqlServerTraceCapabilities {
  const row = result.rows[0];
  if (!row) throw new Error("SQL Server did not return trace capability information");
  const productVersion = textValue(cell(result, row, "product_version"));
  const majorVersion = Number.parseInt(productVersion.split(".")[0] || "", 10);
  const databaseId = numberValue(cell(result, row, "database_id"));
  const engineEdition = numberValue(cell(result, row, "engine_edition"));
  if (!Number.isInteger(majorVersion) || !Number.isInteger(databaseId) || !Number.isInteger(engineEdition)) {
    throw new Error("SQL Server returned incomplete trace capability information");
  }
  return {
    productVersion,
    majorVersion,
    engineEdition: engineEdition!,
    databaseId: databaseId!,
    canAlterEventSession: booleanValue(cell(result, row, "can_alter_event_session")),
    canViewServerState: booleanValue(cell(result, row, "can_view_server_state")),
    canViewServerPerformanceState: booleanValue(cell(result, row, "can_view_server_performance_state")),
    hasRpcCompletedEvent: booleanValue(cell(result, row, "has_rpc_completed_event")),
    hasSqlBatchCompletedEvent: booleanValue(cell(result, row, "has_sql_batch_completed_event")),
    hasSpStatementCompletedEvent: booleanValue(cell(result, row, "has_sp_statement_completed_event")),
    hasRingBufferTarget: booleanValue(cell(result, row, "has_ring_buffer_target")),
    hasDatabaseIdPredicate: booleanValue(cell(result, row, "has_database_id_predicate")),
    hasLikePredicate: booleanValue(cell(result, row, "has_like_predicate")),
    availableActions: new Set(
      textValue(cell(result, row, "available_actions"))
        .split(",")
        .filter(Boolean),
    ),
  };
}

const REQUIRED_SQLSERVER_TRACE_ACTIONS = ["client_app_name", "client_hostname", "database_id", "database_name", "server_principal_name", "session_id", "sql_text"] as const;

export function missingSqlServerTraceCapabilities(capabilities: SqlServerTraceCapabilities, includeStatements: boolean): string[] {
  const missing: string[] = [];
  if (!capabilities.hasRpcCompletedEvent) missing.push("sqlserver.rpc_completed");
  if (!capabilities.hasSqlBatchCompletedEvent) missing.push("sqlserver.sql_batch_completed");
  if (includeStatements && !capabilities.hasSpStatementCompletedEvent) missing.push("sqlserver.sp_statement_completed");
  if (!capabilities.hasRingBufferTarget) missing.push("package0.ring_buffer");
  if (!capabilities.hasDatabaseIdPredicate) missing.push("sqlserver.database_id predicate");
  if (!capabilities.hasLikePredicate) missing.push("sqlserver.like_i_sql_unicode_string predicate");
  for (const action of REQUIRED_SQLSERVER_TRACE_ACTIONS) {
    if (!capabilities.availableActions.has(action)) missing.push(`sqlserver.${action} action`);
  }
  return missing;
}

export type SqlServerTraceCapabilityProblem = "unsupported-version" | "unsupported-engine" | "alter-permission" | "view-permission" | "missing-capability";

export function sqlServerTraceCapabilityProblem(capabilities: SqlServerTraceCapabilities, includeStatements = false): SqlServerTraceCapabilityProblem | null {
  if (capabilities.majorVersion < 10) return "unsupported-version";
  // Azure SQL Database uses database-scoped XE sessions, which are outside the
  // first release. Boxed SQL Server, Managed Instance and SQL Edge use SERVER.
  if (![1, 2, 3, 4, 8, 9].includes(capabilities.engineEdition)) return "unsupported-engine";
  if (!capabilities.canAlterEventSession) return "alter-permission";
  if (capabilities.majorVersion >= 16 ? !capabilities.canViewServerPerformanceState : !capabilities.canViewServerState) return "view-permission";
  if (missingSqlServerTraceCapabilities(capabilities, includeStatements).length > 0) return "missing-capability";
  return null;
}

function traceEventSql(eventName: "rpc_completed" | "sql_batch_completed" | "sp_statement_completed", databaseId: number): string {
  return `ADD EVENT sqlserver.${eventName}(
  ACTION(
    sqlserver.client_app_name,
    sqlserver.client_hostname,
    sqlserver.database_id,
    sqlserver.database_name,
    sqlserver.server_principal_name,
    sqlserver.session_id,
    sqlserver.sql_text
  )
  WHERE (
    [sqlserver].[database_id]=(${databaseId})
    AND NOT [sqlserver].[like_i_sql_unicode_string]([sqlserver].[sql_text],N'%${SQLSERVER_TRACE_INTERNAL_MARKER}%')
  ))`;
}

export function buildCreateSqlServerTraceSessionSql(options: SqlServerTraceSessionOptions): string {
  const sessionName = assertSessionName(options.sessionName);
  if (!Number.isInteger(options.databaseId) || options.databaseId <= 0) throw new Error("Invalid SQL Server database id");
  const maxEvents = normalizeSqlServerTraceMaxEvents(options.maxEvents);
  const events = [traceEventSql("rpc_completed", options.databaseId), traceEventSql("sql_batch_completed", options.databaseId)];
  if (options.includeStatements) events.push(traceEventSql("sp_statement_completed", options.databaseId));
  return internalSql(`IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = ${sqlString(sessionName)})
  DROP EVENT SESSION [${sessionName}] ON SERVER;
CREATE EVENT SESSION [${sessionName}] ON SERVER
${events.join(",\n")}
ADD TARGET package0.ring_buffer(
  SET max_events_limit=(${Math.min(maxEvents, SQLSERVER_TRACE_RING_BUFFER_MAX_EVENTS)}), max_memory=(4096)
)
WITH (
  MAX_MEMORY=4096 KB,
  EVENT_RETENTION_MODE=ALLOW_SINGLE_EVENT_LOSS,
  MAX_DISPATCH_LATENCY=1 SECONDS,
  TRACK_CAUSALITY=OFF,
  STARTUP_STATE=OFF
);
ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = START;`);
}

export function buildReadSqlServerTraceEventsSql(sessionName: string, afterTimestamp?: string): string {
  assertSessionName(sessionName);
  const cursorPredicate = afterTimestamp ? `WHERE event_time_utc >= CONVERT(datetime2(7), ${sqlString(afterTimestamp.replace(" ", "T"))}, 126)` : "";
  return internalSql(`;WITH target AS (
  SELECT CAST(target.target_data AS xml) AS target_data
  FROM sys.dm_xe_session_targets target
  JOIN sys.dm_xe_sessions session ON session.address = target.event_session_address
  WHERE session.name = ${sqlString(sessionName)} AND target.target_name = N'ring_buffer'
), event_rows AS (
SELECT
  event_node.value('(@name)[1]', 'nvarchar(128)') AS event_name,
  event_node.value('(@timestamp)[1]', 'datetime2(7)') AS event_time_utc,
  event_node.value('(action[@name="database_name"]/value/text())[1]', 'nvarchar(128)') AS database_name,
  COALESCE(
    NULLIF(event_node.value('(data[@name="statement"]/value/text())[1]', 'nvarchar(max)'), N''),
    NULLIF(event_node.value('(data[@name="batch_text"]/value/text())[1]', 'nvarchar(max)'), N''),
    event_node.value('(action[@name="sql_text"]/value/text())[1]', 'nvarchar(max)')
  ) AS sql_text,
  event_node.value('(data[@name="duration"]/value/text())[1]', 'bigint') AS duration_us,
  event_node.value('(data[@name="cpu_time"]/value/text())[1]', 'bigint') AS cpu_time_us,
  event_node.value('(data[@name="logical_reads"]/value/text())[1]', 'bigint') AS logical_reads,
  event_node.value('(data[@name="writes"]/value/text())[1]', 'bigint') AS writes,
  event_node.value('(data[@name="row_count"]/value/text())[1]', 'bigint') AS row_count,
  event_node.value('(action[@name="session_id"]/value/text())[1]', 'int') AS session_id,
  event_node.value('(action[@name="server_principal_name"]/value/text())[1]', 'nvarchar(256)') AS login_name,
  event_node.value('(action[@name="client_hostname"]/value/text())[1]', 'nvarchar(256)') AS host_name,
  event_node.value('(action[@name="client_app_name"]/value/text())[1]', 'nvarchar(256)') AS client_app,
  event_node.value('(data[@name="result"]/text/text())[1]', 'nvarchar(256)') AS result_text
FROM target
CROSS APPLY target_data.nodes('/RingBufferTarget/event') AS events(event_node)
), bounded_events AS (
  SELECT TOP (${SQLSERVER_TRACE_READ_BATCH_SIZE}) *
  FROM event_rows
  ${cursorPredicate}
  ORDER BY event_time_utc DESC
)
SELECT *
FROM bounded_events
ORDER BY event_time_utc;`);
}

export function buildStopSqlServerTraceSessionSql(sessionName: string): string {
  assertSessionName(sessionName);
  return internalSql(`IF EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = ${sqlString(sessionName)})
  ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = STOP;`);
}

export function buildDropSqlServerTraceSessionSql(sessionName: string): string {
  assertSessionName(sessionName);
  return internalSql(`IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = ${sqlString(sessionName)})
  DROP EVENT SESSION [${sessionName}] ON SERVER;`);
}

export function buildListSqlServerTraceSessionsSql(): string {
  return internalSql(`SELECT name
FROM sys.server_event_sessions
WHERE name LIKE N'${SQLSERVER_TRACE_SESSION_PREFIX}%';`);
}

export function sqlServerTraceSessionExpiresAt(sessionName: string): number | null {
  if (!isValidSqlServerTraceSessionName(sessionName)) return null;
  const encoded = sessionName.slice(SQLSERVER_TRACE_SESSION_PREFIX.length).split("_")[0];
  const timestamp = Number.parseInt(encoded, 36);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function staleSqlServerTraceSessionNames(result: QueryResult, now = Date.now()): string[] {
  return result.rows
    .map((row) => textValue(cell(result, row, "name")))
    .filter((name) => {
      const expiresAt = sqlServerTraceSessionExpiresAt(name);
      return expiresAt !== null && expiresAt <= now;
    });
}

export function buildCleanupSqlServerTraceSessionsSql(sessionNames: string[]): string {
  const names = [...new Set(sessionNames.map(assertSessionName))];
  if (names.length === 0) return internalSql("SELECT 0 AS cleaned_sessions;");
  return internalSql(
    `${names
      .map(
        (name) => `IF EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = ${sqlString(name)})
  ALTER EVENT SESSION [${name}] ON SERVER STATE = STOP;
IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = ${sqlString(name)})
  DROP EVENT SESSION [${name}] ON SERVER;`,
      )
      .join("\n")}\nSELECT ${names.length} AS cleaned_sessions;`,
  );
}

function microsecondsToMilliseconds(value: QueryCell): number | null {
  const microseconds = numberValue(value);
  return microseconds === null ? null : microseconds / 1000;
}

function eventKey(event: Omit<SqlServerTraceEvent, "key">): string {
  return [event.timestamp, event.eventName, event.sessionId ?? "", event.durationMs ?? "", event.sqlText].join("\u0001");
}

export function parseSqlServerTraceEvents(result: QueryResult): SqlServerTraceEvent[] {
  return result.rows
    .map((row) => {
      const event: Omit<SqlServerTraceEvent, "key"> = {
        eventName: textValue(cell(result, row, "event_name")),
        timestamp: textValue(cell(result, row, "event_time_utc")),
        database: textValue(cell(result, row, "database_name")),
        sqlText: textValue(cell(result, row, "sql_text")),
        durationMs: microsecondsToMilliseconds(cell(result, row, "duration_us")),
        cpuMs: microsecondsToMilliseconds(cell(result, row, "cpu_time_us")),
        logicalReads: numberValue(cell(result, row, "logical_reads")),
        writes: numberValue(cell(result, row, "writes")),
        rowCount: numberValue(cell(result, row, "row_count")),
        sessionId: numberValue(cell(result, row, "session_id")),
        loginName: textValue(cell(result, row, "login_name")),
        hostName: textValue(cell(result, row, "host_name")),
        clientApp: textValue(cell(result, row, "client_app")),
        result: textValue(cell(result, row, "result_text")),
      };
      return { ...event, key: eventKey(event) };
    })
    .filter((event) => event.eventName && !event.sqlText.includes(SQLSERVER_TRACE_INTERNAL_MARKER));
}

export function mergeSqlServerTraceEventSnapshot(existingCounts: ReadonlyMap<string, number>, snapshot: SqlServerTraceEvent[]): { additions: SqlServerTraceEvent[]; counts: Map<string, number> } {
  const snapshotCounts = new Map<string, number>();
  const additions: SqlServerTraceEvent[] = [];
  for (const event of snapshot) {
    const occurrence = (snapshotCounts.get(event.key) ?? 0) + 1;
    snapshotCounts.set(event.key, occurrence);
    if (occurrence > (existingCounts.get(event.key) ?? 0)) {
      additions.push({ ...event, key: `${event.key}\u0001${occurrence}` });
    }
  }
  const counts = new Map(existingCounts);
  for (const [key, count] of snapshotCounts) counts.set(key, Math.max(counts.get(key) ?? 0, count));
  return { additions, counts };
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const text = /^[\t\r]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sqlServerTraceEventsToCsv(events: SqlServerTraceEvent[]): string {
  const header = ["time_utc", "event", "database", "sql_text", "duration_ms", "cpu_ms", "logical_reads", "writes", "row_count", "session_id", "login", "host", "client_app", "result"];
  const rows = events.map((event) => [event.timestamp, event.eventName, event.database, event.sqlText, event.durationMs, event.cpuMs, event.logicalReads, event.writes, event.rowCount, event.sessionId, event.loginName, event.hostName, event.clientApp, event.result]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

import type { QueryResult } from "@/types/database";
import type { ProcessColumn, ProcessRow } from "@/lib/database/processListDrivers";

const ORACLE_COLUMNS: ProcessColumn[] = [
  { key: "id", labelKey: "processList.colId", mono: true },
  { key: "serial", labelKey: "processList.oracleSerial", mono: true },
  { key: "instance", labelKey: "processList.oracleInstance", mono: true },
  { key: "container", labelKey: "processList.oracleContainer", mono: true },
  { key: "user", labelKey: "processList.colUser" },
  { key: "status", labelKey: "processList.colState" },
  { key: "machine", labelKey: "processList.colClient" },
  { key: "program", labelKey: "processList.oracleProgram", wide: true },
  { key: "sqlId", labelKey: "processList.oracleSqlId", mono: true },
  { key: "wait", labelKey: "processList.colWait", wide: true },
  { key: "blocker", labelKey: "processList.oracleBlocker", mono: true },
];

const OCEANBASE_COLUMNS: ProcessColumn[] = [
  { key: "id", labelKey: "processList.colId", mono: true },
  { key: "user", labelKey: "processList.colUser" },
  { key: "tenant", labelKey: "processList.oracleTenant" },
  { key: "host", labelKey: "processList.colHost" },
  { key: "db", labelKey: "processList.colDb" },
  { key: "command", labelKey: "processList.colCommand" },
  { key: "time", labelKey: "processList.colTime" },
  { key: "state", labelKey: "processList.colState" },
  { key: "info", labelKey: "processList.colInfo", wide: true, mono: true },
  { key: "server", labelKey: "processList.oracleNode", mono: true },
];

const ORACLE_VERSION_SQL = "SELECT VERSION FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle Database%' AND ROWNUM = 1";
const ORACLE_OWN_SQL = `SELECT TO_CHAR(SYS_CONTEXT('USERENV','SID')), TO_CHAR(SYS_CONTEXT('USERENV','INSTANCE')), TO_CHAR(SYS_CONTEXT('USERENV','CON_ID')) FROM DUAL`;
const ORACLE_LEGACY_OWN_SQL = `SELECT TO_CHAR(SYS_CONTEXT('USERENV','SID')), TO_CHAR(SYS_CONTEXT('USERENV','INSTANCE')), '0' FROM DUAL`;

export type OracleSessionTarget = ProcessRow & {
  id: string;
  serial: string;
  instance: string;
  container: string;
  user: string;
  auditSession: string;
  logonTime: string;
};

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function positiveInteger(value: string, label: string): string {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error(`Invalid ${label}`);
  return String(Number(value));
}

function nonNegativeInteger(value: string, label: string): string {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error(`Invalid ${label}`);
  return String(Number(value));
}

function positiveDecimalString(value: string, label: string): string {
  if (!/^\d+$/.test(value) || !/[1-9]/.test(value)) throw new Error(`Invalid ${label}`);
  return value.replace(/^0+(?=\d)/, "");
}

export function oracleMajorVersion(version: string): number | null {
  const match = version.match(/^\s*(\d+)(?:\.|\s|$)/);
  const major = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

export function buildOracleSessionListSql(legacy: boolean): string {
  const container = legacy ? "'0'" : "TO_CHAR(s.CON_ID)";
  const predicate = legacy ? "" : " AND s.CON_ID = TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID'))";
  return `SELECT TO_CHAR(s.SID) AS SESSION_ID, TO_CHAR(s.SERIAL#) AS SERIAL_NUMBER, TO_CHAR(s.INST_ID) AS INSTANCE_ID, ${container} AS CONTAINER_ID, s.USERNAME AS SESSION_USER, s.STATUS AS SESSION_STATUS, s.MACHINE AS MACHINE, s.PROGRAM AS PROGRAM, s.SQL_ID AS SQL_ID, s.EVENT || CASE WHEN s.WAIT_CLASS IS NULL THEN '' ELSE ' (' || s.WAIT_CLASS || ')' END AS WAIT_INFO, TO_CHAR(s.BLOCKING_INSTANCE) AS BLOCKING_INSTANCE, TO_CHAR(s.BLOCKING_SESSION) AS BLOCKING_SESSION, TO_CHAR(s.AUDSID) AS AUDIT_SESSION, TO_CHAR(s.LOGON_TIME,'YYYY-MM-DD HH24:MI:SS') AS LOGON_TIME\nFROM GV$SESSION s\nWHERE s.USERNAME IS NOT NULL${predicate}\nORDER BY s.INST_ID, s.SID`;
}

export function buildOracleOwnSessionSql(legacy: boolean): string {
  return legacy ? ORACLE_LEGACY_OWN_SQL : ORACLE_OWN_SQL;
}

export function mapOracleSessions(result: QueryResult | null | undefined): OracleSessionTarget[] {
  return (result?.rows ?? []).flatMap((row) => {
    const [id, serial, instance, container, user, status, machine, program, sqlId, wait, blockingInstance, blockingSession, auditSession, logonTime] = row;
    if ([id, serial, instance, container, user].some((value) => value === null || value === undefined || String(value) === "")) return [];
    return [
      {
        id: String(id),
        serial: String(serial),
        instance: String(instance),
        container: String(container),
        user: String(user),
        status: String(status ?? ""),
        machine: String(machine ?? ""),
        program: String(program ?? ""),
        sqlId: String(sqlId ?? ""),
        wait: String(wait ?? ""),
        blockingInstance: String(blockingInstance ?? ""),
        blockingSession: String(blockingSession ?? ""),
        blocker: blockingSession === null || blockingSession === undefined ? "" : `${String(blockingInstance ?? "")}:${String(blockingSession)}`,
        auditSession: String(auditSession ?? ""),
        logonTime: String(logonTime ?? ""),
      } as OracleSessionTarget,
    ];
  });
}

export function buildOracleKillSessionBlock(target: OracleSessionTarget, legacy: boolean): string {
  const sid = positiveInteger(target.id, "SID");
  const serial = positiveInteger(target.serial, "serial number");
  const instance = positiveInteger(target.instance, "instance id");
  const containerId = legacy ? "0" : nonNegativeInteger(target.container, "container id");
  const conIdProjection = legacy ? "0" : "CON_ID";
  const conIdPredicate = legacy ? "" : ` AND CON_ID = ${containerId}`;
  const selfIdentity = legacy
    ? `TO_NUMBER(SYS_CONTEXT('USERENV','SID')) = ${sid} AND TO_NUMBER(SYS_CONTEXT('USERENV','INSTANCE')) = ${instance}`
    : `TO_NUMBER(SYS_CONTEXT('USERENV','SID')) = ${sid} AND TO_NUMBER(SYS_CONTEXT('USERENV','INSTANCE')) = ${instance} AND TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) = ${containerId}`;
  const identity = `SID = ${sid} AND SERIAL# = ${serial} AND INST_ID = ${instance}${conIdPredicate} AND USERNAME = ${sqlLiteral(target.user)} AND AUDSID = ${positiveInteger(target.auditSession, "audit session id")} AND TO_CHAR(LOGON_TIME,'YYYY-MM-DD HH24:MI:SS') = ${sqlLiteral(target.logonTime)}`;
  const currentContainerCheck = legacy ? "" : ` OR TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) <> ${containerId}`;
  return `DECLARE\n  v_self_serial NUMBER;\n  v_self_container NUMBER := ${legacy ? "0" : "TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID'))"};\n  v_target_count NUMBER;\nBEGIN\n  IF ${selfIdentity} THEN\n    SELECT SERIAL# INTO v_self_serial FROM GV$SESSION WHERE SID = ${sid} AND INST_ID = ${instance} AND ${conIdProjection} = v_self_container;\n    IF v_self_serial = ${serial} THEN RAISE_APPLICATION_ERROR(-20001, 'Cannot terminate the executing management session'); END IF;\n  END IF;\n  SELECT COUNT(*) INTO v_target_count FROM GV$SESSION WHERE ${identity};\n  IF v_target_count <> 1${currentContainerCheck} THEN RAISE_APPLICATION_ERROR(-20002, 'Session identity changed; refresh the list'); END IF;\n  EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''${sid},${serial},@${instance}'' IMMEDIATE';\nEND;`;
}

export function oracleSessionRowKey(row: ProcessRow): string {
  return JSON.stringify([row.container, row.instance, row.id, row.serial, row.auditSession, row.logonTime]);
}

export function oracleTargetIsSelf(row: ProcessRow, ownRow: unknown[] | null): boolean {
  return !!ownRow && String(row.id) === String(ownRow[0] ?? "") && String(row.instance) === String(ownRow[1] ?? "") && String(row.container) === String(ownRow[2] ?? "");
}

export function canTerminateOracleSession(row: ProcessRow): boolean {
  const positive = (value: unknown) => /^\d+$/.test(String(value ?? "")) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const container = (value: unknown) => /^\d+$/.test(String(value ?? "")) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  return positive(row.id) && positive(row.serial) && positive(row.instance) && container(row.container) && positive(row.auditSession) && !!row.user && !!row.logonTime;
}

export function buildOracleLockDetailsSql(target: OracleSessionTarget, legacy: boolean): string {
  const sid = positiveInteger(target.id, "SID");
  const serial = positiveInteger(target.serial, "serial number");
  const instance = positiveInteger(target.instance, "instance id");
  const container = legacy ? "0" : nonNegativeInteger(target.container, "container id");
  const conIdColumn = legacy ? "0" : "l.CON_ID";
  const sessionConId = legacy ? "0" : "s.CON_ID";
  const containerJoin = legacy ? "" : " AND s.CON_ID = l.CON_ID";
  const containerFilter = legacy ? "" : ` AND l.CON_ID = ${container}`;
  const targetConId = legacy ? "" : ` AND target.CON_ID = ${container}`;
  const related = `s.SID = ${sid} AND s.INST_ID = ${instance}${legacy ? "" : ` AND s.CON_ID = ${container}`}`;
  const blockerMatch =
    /^\d+$/.test(String(target.blockingSession ?? "")) && Number(target.blockingSession) > 0 && /^\d+$/.test(String(target.blockingInstance ?? "")) && Number(target.blockingInstance) > 0
      ? `s.SID = ${positiveInteger(String(target.blockingSession), "blocking SID")} AND s.INST_ID = ${positiveInteger(String(target.blockingInstance), "blocking instance")}${legacy ? "" : ` AND s.CON_ID = ${container}`}`
      : "1 = 0";
  const targetIdentity = `target.SID = ${sid} AND target.SERIAL# = ${serial} AND target.INST_ID = ${instance}${targetConId} AND target.USERNAME = ${sqlLiteral(target.user)} AND target.AUDSID = ${positiveInteger(target.auditSession, "audit session id")} AND TO_CHAR(target.LOGON_TIME,'YYYY-MM-DD HH24:MI:SS') = ${sqlLiteral(target.logonTime)}`;
  return `SELECT ${conIdColumn} AS CONTAINER_ID, l.INST_ID AS INSTANCE_ID, l.SID AS SESSION_ID, l.TYPE AS LOCK_TYPE, TO_CHAR(l.ID1) AS ID1, TO_CHAR(l.ID2) AS ID2, l.LMODE AS HELD_MODE, l.REQUEST AS REQUESTED_MODE, l.BLOCK AS BLOCKING, s.USERNAME AS SESSION_USER, s.STATUS AS SESSION_STATUS, TO_CHAR(s.BLOCKING_INSTANCE) || ':' || TO_CHAR(s.BLOCKING_SESSION) AS BLOCKER\nFROM GV$LOCK l JOIN GV$SESSION s ON s.SID = l.SID AND s.INST_ID = l.INST_ID${containerJoin}\nWHERE EXISTS (SELECT 1 FROM GV$SESSION target WHERE ${targetIdentity}) AND (${related} OR ${blockerMatch} OR s.BLOCKING_INSTANCE = ${instance} AND s.BLOCKING_SESSION = ${sid}${legacy ? "" : ` AND ${sessionConId} = ${container}`})${containerFilter}\nORDER BY l.TYPE, l.ID1, l.ID2, l.REQUEST`;
}

export function buildOceanbaseSessionListSql(): string {
  // In Oracle mode bare USER is the login function, not the USER dictionary column.
  return `SELECT TO_CHAR(ID) AS SESSION_ID, "USER" AS SESSION_USER, TENANT AS TENANT, HOST AS HOST, DB AS DB_NAME, COMMAND AS COMMAND, TIME AS ELAPSED_TIME, STATE AS STATE, INFO AS INFO, PROXY_SESSID AS PROXY_SESSION_ID, SVR_IP AS SERVER_IP, SVR_PORT AS SERVER_PORT, SQL_ID AS SQL_ID, TRACE_ID AS TRACE_ID FROM GV$OB_PROCESSLIST WHERE TENANT = (SELECT TENANT FROM GV$OB_SESSION WHERE ID = SYS_CONTEXT('USERENV','SID') AND "USER" = SYS_CONTEXT('USERENV','SESSION_USER') AND ROWNUM = 1) ORDER BY ID`;
}

export const OCEANBASE_OWN_SESSION_SQL = `SELECT TO_CHAR(ID), "USER", TENANT FROM GV$OB_SESSION WHERE ID = SYS_CONTEXT('USERENV','SID') AND "USER" = SYS_CONTEXT('USERENV','SESSION_USER') AND ROWNUM = 1`;

export function mapOceanbaseSessions(result: QueryResult | null | undefined): ProcessRow[] {
  return (result?.rows ?? []).flatMap((row) => {
    const [id, user, tenant, host, db, command, time, state, info, proxySessionId, serverIp, serverPort, sqlId, traceId] = row;
    if (id === null || id === undefined || !/^\d+$/.test(String(id)) || user === null || tenant === null) return [];
    return [
      {
        id: String(id),
        user: String(user),
        tenant: String(tenant),
        host: String(host ?? ""),
        db: String(db ?? ""),
        command: String(command ?? ""),
        time: String(time ?? ""),
        state: String(state ?? ""),
        info: String(info ?? ""),
        proxySessionId: proxySessionId === null || proxySessionId === undefined ? null : String(proxySessionId),
        serverIp: String(serverIp ?? ""),
        serverPort: String(serverPort ?? ""),
        server: `${String(serverIp ?? "")}:${String(serverPort ?? "")}`,
        sqlId: String(sqlId ?? ""),
        traceId: String(traceId ?? ""),
      },
    ];
  });
}

export function buildOceanbaseKillConnectionBlock(row: ProcessRow): string {
  const user = String(row.user ?? "");
  const tenant = String(row.tenant ?? "");
  const serverIp = String(row.serverIp ?? "");
  const serverPort = positiveInteger(String(row.serverPort ?? ""), "server port");
  if (!user || !tenant || !serverIp || (row.proxySessionId !== null && row.proxySessionId !== undefined && String(row.proxySessionId) !== "")) throw new Error("Unsupported or incomplete OceanBase session identity");
  const id = positiveDecimalString(String(row.id), "session id");
  return `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM GV$OB_SESSION WHERE ID = ${id} AND "USER" = ${sqlLiteral(user)} AND TENANT = ${sqlLiteral(tenant)} AND SVR_IP = ${sqlLiteral(serverIp)} AND SVR_PORT = ${serverPort} AND PROXY_SESSID IS NULL; IF TO_NUMBER(SYS_CONTEXT('USERENV','SID')) = ${id} AND USER = ${sqlLiteral(user)} THEN RAISE_APPLICATION_ERROR(-20002, 'Cannot terminate the executing management session'); END IF; IF n = 1 THEN EXECUTE IMMEDIATE 'KILL CONNECTION ${id}'; ELSE RAISE_APPLICATION_ERROR(-20001, 'Session identity changed or is not directly addressable'); END IF; END;`;
}

export function oceanbaseSessionRowKey(row: ProcessRow): string {
  return JSON.stringify([row.tenant, row.serverIp, row.serverPort, row.id, row.user, row.proxySessionId]);
}

export function canTerminateOceanbaseSession(row: ProcessRow): boolean {
  return /^\d+$/.test(String(row.id)) && /[1-9]/.test(String(row.id)) && !!row.user && !!row.tenant && !!row.serverIp && /^\d+$/.test(String(row.serverPort)) && String(row.serverPort) !== "0" && (row.proxySessionId === null || row.proxySessionId === undefined || String(row.proxySessionId) === "");
}

export function buildOceanbaseLockDetailsSql(row: ProcessRow): string {
  const id = positiveDecimalString(String(row.id), "session id");
  const user = String(row.user ?? "");
  const tenant = String(row.tenant ?? "");
  const serverIp = String(row.serverIp ?? "");
  const serverPort = positiveInteger(String(row.serverPort ?? ""), "server port");
  if (!user || !tenant || !serverIp) throw new Error("Incomplete OceanBase session identity");
  const proxySessionPredicate = row.proxySessionId === null || row.proxySessionId === undefined || String(row.proxySessionId) === "" ? "IS NULL" : `= ${sqlLiteral(String(row.proxySessionId))}`;
  const targetSessionIdentity = `tp.ID = ${id} AND tp."USER" = ${sqlLiteral(user)} AND tp.TENANT = ${sqlLiteral(tenant)} AND tp.SVR_IP = ${sqlLiteral(serverIp)} AND tp.SVR_PORT = ${serverPort} AND tp.PROXY_SESSID ${proxySessionPredicate}`;
  const targetLockIdentity = `tl.SESSION_ID = ${id} AND tl.SVR_IP = ${sqlLiteral(serverIp)} AND tl.SVR_PORT = ${serverPort}`;
  const tenantIds = `SELECT DISTINCT tl.TENANT_ID FROM GV$OB_LOCKS tl WHERE ${targetLockIdentity} AND EXISTS (SELECT 1 FROM GV$OB_PROCESSLIST tp WHERE ${targetSessionIdentity})`;
  return `SELECT l.SVR_IP, l.SVR_PORT, l.TENANT_ID, l.TRANS_ID, l.SESSION_ID, l.TYPE, TO_CHAR(l.ID1), TO_CHAR(l.ID2), TO_CHAR(l.ID3), l.LMODE, l.REQUEST, l.CTIME, l.BLOCK, p."USER" AS SESSION_USER, p.STATE AS SESSION_STATE FROM GV$OB_LOCKS l LEFT JOIN GV$OB_PROCESSLIST p ON p.ID = l.SESSION_ID AND p.TENANT = ${sqlLiteral(tenant)} AND p.SVR_IP = l.SVR_IP AND p.SVR_PORT = l.SVR_PORT WHERE l.TENANT_ID IN (${tenantIds}) AND ((l.SESSION_ID = ${id} AND l.SVR_IP = ${sqlLiteral(serverIp)} AND l.SVR_PORT = ${serverPort}) OR EXISTS (SELECT 1 FROM GV$OB_LOCKS tl WHERE ${targetLockIdentity} AND tl.TYPE = l.TYPE AND tl.ID1 = l.ID1 AND tl.ID2 = l.ID2 AND tl.ID3 = l.ID3)) ORDER BY l.TYPE, l.ID1, l.ID2, l.SESSION_ID, l.TRANS_ID`;
}

export const ORACLE_SESSION_DRIVER_COLUMNS = ORACLE_COLUMNS;
export const OCEANBASE_SESSION_DRIVER_COLUMNS = OCEANBASE_COLUMNS;
export const ORACLE_SESSION_VERSION_SQL = ORACLE_VERSION_SQL;

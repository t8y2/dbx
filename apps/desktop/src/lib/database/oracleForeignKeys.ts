import * as api from "@/lib/backend/api";
import type { BuildTableStructureChangeSqlOptions, OracleForeignKeyChange, OracleForeignKeyDefinition, OracleForeignKeyState, OracleTriggerStructureOperation, TablePartitionDefinition } from "@/lib/table/tableStructureEditorSql";
import { foldCreatedTableName } from "@/lib/table/tableStructureEditorState";

export interface OracleForeignKeyTarget {
  connectionId: string;
  database: string;
  schema: string;
  tableName: string;
  catalog?: string;
  databaseType: "oracle" | "oceanbase-oracle";
}

export class OracleForeignKeyMetadataError extends Error {
  constructor() {
    super("Foreign key metadata is incomplete, unsupported, or inconsistent. Refresh the table definition.");
  }
}

function invalid(): never {
  throw new OracleForeignKeyMetadataError();
}
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Parses database-emitted REF_CONSTRAINT DDL. The returned text is never executed. */
export function parseOracleForeignKeyDdl(ddl: string, target: OracleForeignKeyTarget, name: string, refOwner: string, deleteRule: string, state: OracleForeignKeyState): OracleForeignKeyDefinition {
  let position = 0;
  const whitespace = () => {
    while (/\s/.test(ddl[position] ?? "") && position < ddl.length) position++;
  };
  const symbol = (value: string, required = true): boolean => {
    whitespace();
    if (ddl[position] !== value) {
      if (required) invalid();
      return false;
    }
    position++;
    return true;
  };
  const word = (value: string, required = true): boolean => {
    whitespace();
    const end = position + value.length;
    if (ddl.slice(position, end).toUpperCase() !== value || /[\w$#]/.test(ddl[end] ?? "")) {
      if (required) invalid();
      return false;
    }
    position = end;
    return true;
  };
  const identifier = (): string => {
    symbol('"');
    let value = "";
    while (position < ddl.length) {
      const character = ddl[position++]!;
      if (character !== '"') {
        value += character;
        continue;
      }
      if (ddl[position] === '"') {
        position++;
        value += '"';
        continue;
      }
      return value || invalid();
    }
    return invalid();
  };
  const columns = (): string[] => {
    symbol("(");
    const values = [identifier()];
    while (symbol(",", false)) values.push(identifier());
    symbol(")");
    if (new Set(values).size !== values.length) invalid();
    return values;
  };
  word("ALTER");
  word("TABLE");
  const sourceOwner = identifier();
  symbol(".");
  const sourceTable = identifier();
  word("ADD");
  word("CONSTRAINT");
  const constraint = identifier();
  word("FOREIGN");
  word("KEY");
  const local = columns();
  word("REFERENCES");
  const refSchema = identifier();
  symbol(".");
  const refTable = identifier();
  const references = columns();
  let onDelete: OracleForeignKeyDefinition["onDelete"] = "NO ACTION";
  if (word("ON", false)) {
    word("DELETE");
    if (word("CASCADE", false)) onDelete = "CASCADE";
    else {
      word("SET");
      word("NULL");
      onDelete = "SET NULL";
    }
  }
  const observed: Partial<OracleForeignKeyState> = {};
  const setState = (key: keyof OracleForeignKeyState, value: boolean) => {
    if (key in observed) invalid();
    observed[key] = value;
  };
  while (true) {
    whitespace();
    if (position === ddl.length) break;
    if (symbol(";", false)) {
      whitespace();
      if (position !== ddl.length) invalid();
      break;
    }
    if (word("ENABLE", false)) setState("enabled", true);
    else if (word("DISABLE", false)) setState("enabled", false);
    else if (word("VALIDATE", false)) setState("validated", true);
    else if (word("NOVALIDATE", false)) setState("validated", false);
    else if (word("RELY", false)) setState("rely", true);
    else if (word("NORELY", false)) setState("rely", false);
    else if (word("DEFERRABLE", false)) setState("deferrable", true);
    else if (word("NOT", false)) {
      word("DEFERRABLE");
      setState("deferrable", false);
    } else if (word("INITIALLY", false)) {
      if (word("DEFERRED", false)) setState("initiallyDeferred", true);
      else {
        word("IMMEDIATE");
        setState("initiallyDeferred", false);
      }
    } else invalid();
  }
  for (const key of Object.keys(observed) as Array<keyof OracleForeignKeyState>) {
    if (key === "rely" && state.validated) continue;
    if (observed[key] !== state[key]) invalid();
  }
  if (sourceOwner !== target.schema || sourceTable !== target.tableName || constraint !== name || refSchema !== refOwner || onDelete !== deleteRule || local.length !== references.length) invalid();
  return { name, columns: local, refSchema, refTable, refColumns: references, onDelete, state: { ...state } };
}

async function query(target: OracleForeignKeyTarget, sql: string, stillCurrent: () => boolean = () => true): Promise<unknown[][]> {
  if (!stillCurrent()) invalid();
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { catalog: target.catalog, maxRows: 10001 });
  if (!stillCurrent()) invalid();
  if (result.execution_error || result.truncated || result.has_more || result.rows.length >= 10001) invalid();
  return result.rows;
}

async function sourceConstraintView(target: OracleForeignKeyTarget, stillCurrent: () => boolean = () => true) {
  if (target.databaseType === "oceanbase-oracle") {
    const users = await query(target, "SELECT USER FROM DUAL", stillCurrent);
    if (users.length !== 1 || users[0]?.length !== 1 || typeof users[0][0] !== "string" || !users[0][0]) invalid();
    if (users[0][0] === target.schema) return { view: "SYS.USER_CONSTRAINTS", owner: "" };
  }
  return { view: "SYS.ALL_CONSTRAINTS", owner: `OWNER = ${literal(target.schema)}` };
}

export async function readOracleForeignKeyConstraintNames(target: OracleForeignKeyTarget, selectedNames?: string[], stillCurrent: () => boolean = () => true): Promise<Array<{ name: string; table: string }>> {
  target = { ...target };
  if (selectedNames && !selectedNames.length) return [];
  const source = await sourceConstraintView(target, stillCurrent);
  const conditions = [source.owner, selectedNames ? `CONSTRAINT_NAME IN (${selectedNames.map(literal).join(", ")})` : ""].filter(Boolean);
  const rows = await query(target, `SELECT CONSTRAINT_NAME, TABLE_NAME FROM ${source.view}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY CONSTRAINT_NAME`, stillCurrent);
  const names = new Set<string>();
  return rows.map((row) => {
    if (row.length !== 2 || typeof row[0] !== "string" || !row[0] || typeof row[1] !== "string" || !row[1] || names.has(row[0])) invalid();
    names.add(row[0]);
    return { name: row[0], table: row[1] };
  });
}

async function readOracleForeignKeyMetadata(target: OracleForeignKeyTarget, selectedNames?: string[], stillCurrent: () => boolean = () => true) {
  target = { ...target };
  if (selectedNames && !selectedNames.length) return { definitions: [], referenceKeys: [] };
  const tables = await query(target, `SELECT OWNER, TABLE_NAME FROM SYS.ALL_TABLES WHERE OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)}`, stillCurrent);
  if (tables.length !== 1 || tables[0]?.length !== 2 || tables[0][0] !== target.schema || tables[0][1] !== target.tableName) invalid();
  const source = await sourceConstraintView(target, stillCurrent);
  const rows = await query(
    target,
    `SELECT CONSTRAINT_NAME, STATUS, VALIDATED, DEFERRABLE, DEFERRED, RELY, R_OWNER, R_CONSTRAINT_NAME, DELETE_RULE FROM ${source.view} WHERE ${source.owner ? `${source.owner} AND ` : ""}TABLE_NAME = ${literal(target.tableName)} AND CONSTRAINT_TYPE = 'R'${selectedNames ? ` AND CONSTRAINT_NAME IN (${selectedNames.map(literal).join(", ")})` : ""} ORDER BY CONSTRAINT_NAME`,
    stillCurrent,
  );
  const names = new Set<string>();
  const definitions: OracleForeignKeyDefinition[] = [];
  const referenceKeys: Array<{ name: string; owner: string; constraint: string }> = [];
  for (const row of rows) {
    const [name, enabled, validated, deferrable, initially, rely, refOwner, refConstraint, action] = row;
    if (
      row.length !== 9 ||
      typeof name !== "string" ||
      !name ||
      names.has(name) ||
      typeof refOwner !== "string" ||
      !refOwner ||
      typeof refConstraint !== "string" ||
      !refConstraint ||
      !["ENABLED", "DISABLED"].includes(String(enabled)) ||
      !["VALIDATED", "NOT VALIDATED"].includes(String(validated)) ||
      !["DEFERRABLE", "NOT DEFERRABLE"].includes(String(deferrable)) ||
      !["IMMEDIATE", "DEFERRED"].includes(String(initially)) ||
      (rely !== null && rely !== "RELY") ||
      !["NO ACTION", "CASCADE", "SET NULL"].includes(String(action))
    )
      invalid();
    const state: OracleForeignKeyState = { enabled: enabled === "ENABLED", validated: validated === "VALIDATED", deferrable: deferrable === "DEFERRABLE", initiallyDeferred: initially === "DEFERRED", rely: validated !== "VALIDATED" && rely === "RELY" };
    if ((!state.deferrable && state.initiallyDeferred) || (target.databaseType === "oceanbase-oracle" && state.deferrable)) invalid();
    names.add(name);
    const ddlRows = await query(target, `SELECT DBMS_METADATA.GET_DDL('REF_CONSTRAINT', ${literal(name)}, ${literal(target.schema)}) FROM DUAL`, stillCurrent);
    if (ddlRows.length !== 1 || ddlRows[0]?.length !== 1 || typeof ddlRows[0][0] !== "string") invalid();
    definitions.push(parseOracleForeignKeyDdl(ddlRows[0][0], target, name, refOwner, String(action), state));
    referenceKeys.push({ name, owner: refOwner, constraint: refConstraint });
  }
  return { definitions, referenceKeys };
}

export async function readOracleForeignKeyDefinitions(target: OracleForeignKeyTarget, stillCurrent: () => boolean = () => true): Promise<OracleForeignKeyDefinition[]> {
  return (await readOracleForeignKeyMetadata(target, undefined, stillCurrent)).definitions;
}

export interface OracleForeignKeySourceSnapshot {
  user: string;
  currentSchema: string;
  objectId: string;
  columns: Array<{ name: string; dataType: string; length: string | null; precision: string | null; scale: string | null; nullable: boolean }>;
  definitions: OracleForeignKeyDefinition[];
  referenceKeys: Array<{ name: string; owner: string; constraint: string }>;
  names: Array<{ name: string; table: string }>;
}

/** Captures only metadata needed for a foreign key write, without issuing DDL. */
export async function readOracleForeignKeySourceSnapshot(target: OracleForeignKeyTarget, changes?: OracleForeignKeyChange[], stillCurrent: () => boolean = () => true): Promise<OracleForeignKeySourceSnapshot> {
  target = { ...target };
  changes = changes ? (JSON.parse(JSON.stringify(changes)) as OracleForeignKeyChange[]) : undefined;
  const originalNames = changes ? changes.flatMap((change) => (change.original ? [change.original.name] : [])) : undefined;
  const selectedNames = changes ? [...new Set(changes.flatMap((change) => [change.original?.name, change.target?.name].filter((name): name is string => name !== undefined)))] : undefined;
  const selectedColumns = changes ? new Set(changes.flatMap((change) => [...(change.original?.columns ?? []), ...(change.target?.columns ?? [])])) : undefined;
  const where = `OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)}`;
  const [identity, objects, columns, metadata, names] = await Promise.all([
    query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL", stillCurrent),
    query(target, `SELECT OWNER, OBJECT_NAME, OBJECT_ID FROM SYS.ALL_OBJECTS WHERE OWNER = ${literal(target.schema)} AND OBJECT_NAME = ${literal(target.tableName)} AND OBJECT_TYPE = 'TABLE'`, stillCurrent),
    query(target, `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE FROM SYS.ALL_TAB_COLS WHERE ${where} ORDER BY COLUMN_ID`, stillCurrent),
    readOracleForeignKeyMetadata(target, originalNames, stillCurrent),
    readOracleForeignKeyConstraintNames(target, selectedNames, stillCurrent),
  ]);
  if (identity.length !== 1 || identity[0]?.length !== 2 || typeof identity[0][0] !== "string" || !identity[0][0] || typeof identity[0][1] !== "string" || !identity[0][1]) invalid();
  if (objects.length !== 1 || objects[0]?.length !== 3 || objects[0][0] !== target.schema || objects[0][1] !== target.tableName || (typeof objects[0][2] !== "string" && typeof objects[0][2] !== "number") || !/^[1-9]\d*$/.test(String(objects[0][2]))) invalid();
  if (typeof objects[0][2] === "number" && !Number.isSafeInteger(objects[0][2])) invalid();
  if (!columns.length) invalid();
  const columnNames = new Set<string>();
  const numeric = (value: unknown): string | null => {
    if (value === null) return null;
    if ((typeof value !== "string" && typeof value !== "number") || !/^-?\d+$/.test(String(value))) invalid();
    return String(value);
  };
  const columnDefinitions = columns.map((row) => {
    if (row.length !== 6 || typeof row[0] !== "string" || !row[0] || columnNames.has(row[0]) || typeof row[1] !== "string" || !row[1] || !["Y", "N"].includes(String(row[5]))) invalid();
    columnNames.add(row[0]);
    return { name: row[0], dataType: row[1], length: numeric(row[2]), precision: numeric(row[3]), scale: numeric(row[4]), nullable: row[5] === "Y" };
  });
  return { user: identity[0][0], currentSchema: identity[0][1], objectId: String(objects[0][2]), columns: selectedColumns ? columnDefinitions.filter((column) => selectedColumns.has(column.name)) : columnDefinitions, definitions: metadata.definitions, referenceKeys: metadata.referenceKeys, names };
}

export function validateOracleForeignKeySourceChanges(snapshot: OracleForeignKeySourceSnapshot, target: OracleForeignKeyTarget, changes: OracleForeignKeyChange[]): void {
  const definitionIdentity = (key: OracleForeignKeyDefinition) => JSON.stringify([key.name, key.columns, key.refSchema, key.refTable, key.refColumns, key.onDelete, key.state.enabled, key.state.validated, key.state.deferrable, key.state.initiallyDeferred, key.state.rely]);
  const originalNames = new Set<string>();
  const targetNames = new Set<string>();
  for (const change of changes) {
    if (!change.original && !change.target) invalid();
    if (change.original) {
      if (originalNames.has(change.original.name)) invalid();
      originalNames.add(change.original.name);
      const existing = snapshot.definitions.find((key) => key.name === change.original!.name);
      if (!existing || definitionIdentity(existing) !== definitionIdentity(change.original)) invalid();
    }
    const definition = change.target;
    if (!definition) continue;
    if (
      !definition.name ||
      targetNames.has(definition.name) ||
      !definition.refSchema ||
      !definition.refTable ||
      !definition.columns.length ||
      definition.columns.length !== definition.refColumns.length ||
      definition.columns.some((name) => !snapshot.columns.some((column) => column.name === name)) ||
      definition.refColumns.some((name) => !name)
    )
      invalid();
    targetNames.add(definition.name);
    if (new Set(definition.columns).size !== definition.columns.length || new Set(definition.refColumns).size !== definition.refColumns.length) invalid();
    if (
      !["NO ACTION", "CASCADE", "SET NULL"].includes(definition.onDelete) ||
      (!definition.state.deferrable && definition.state.initiallyDeferred) ||
      (definition.state.validated && definition.state.rely) ||
      (target.databaseType === "oceanbase-oracle" && (definition.state.deferrable || definition.state.initiallyDeferred))
    )
      invalid();
    const occupied = snapshot.names.find((name) => name.name === definition.name);
    if (occupied && (occupied.table !== target.tableName || change.original?.name !== definition.name)) invalid();
  }
}

export interface OracleForeignKeyReferenceSnapshot {
  owner: string;
  table: string;
  objectId: string | null;
  keys: Array<{ name: string; kind: string; enabled: boolean; validated: boolean; deferrable: boolean; columns: string[] }> | null;
  columns: Array<{ name: string; dataType: string }> | null;
  references: "present" | "missing" | "unknown";
}

/** Missing dictionary visibility is recorded as unknown, never as a missing parent. */
export async function readOracleForeignKeyReferenceSnapshot(target: OracleForeignKeyTarget, user: string, definition: OracleForeignKeyDefinition, stillCurrent: () => boolean = () => true): Promise<OracleForeignKeyReferenceSnapshot> {
  target = { ...target };
  definition = JSON.parse(JSON.stringify(definition)) as OracleForeignKeyDefinition;
  const owner = literal(definition.refSchema),
    table = literal(definition.refTable);
  const sameOwner = definition.refSchema === user;
  const grantee = `(GRANTEE = ${literal(user)} OR GRANTEE = 'PUBLIC')`;
  const requests = await Promise.allSettled([
    query(target, `SELECT OWNER, OBJECT_NAME, OBJECT_ID FROM SYS.ALL_OBJECTS WHERE OWNER = ${owner} AND OBJECT_NAME = ${table} AND OBJECT_TYPE = 'TABLE'`, stillCurrent),
    query(
      target,
      `SELECT c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, c.STATUS, c.VALIDATED, c.DEFERRABLE, cc.COLUMN_NAME, cc.POSITION FROM SYS.ALL_CONSTRAINTS c JOIN SYS.ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME WHERE c.OWNER = ${owner} AND c.TABLE_NAME = ${table} AND c.CONSTRAINT_TYPE IN ('P', 'U') ORDER BY c.CONSTRAINT_NAME, cc.POSITION`,
      stillCurrent,
    ),
    query(target, `SELECT COLUMN_NAME, DATA_TYPE FROM SYS.ALL_TAB_COLS WHERE OWNER = ${owner} AND TABLE_NAME = ${table} ORDER BY COLUMN_ID`, stillCurrent),
    sameOwner ? Promise.resolve([]) : query(target, `SELECT PRIVILEGE FROM SYS.ALL_TAB_PRIVS WHERE TABLE_SCHEMA = ${owner} AND TABLE_NAME = ${table} AND ${grantee} ORDER BY PRIVILEGE`, stillCurrent),
    sameOwner ? Promise.resolve([]) : query(target, `SELECT COLUMN_NAME, PRIVILEGE FROM SYS.ALL_COL_PRIVS WHERE OWNER = ${owner} AND TABLE_NAME = ${table} AND ${grantee} ORDER BY COLUMN_NAME, PRIVILEGE`, stillCurrent),
    sameOwner ? Promise.resolve([]) : query(target, "SELECT PRIVILEGE FROM SESSION_PRIVS ORDER BY PRIVILEGE", stillCurrent),
  ]);
  const rows = (index: number) => (requests[index]?.status === "fulfilled" ? requests[index].value : null);
  const objects = rows(0);
  let objectId: string | null = null;
  if (
    objects?.length === 1 &&
    objects[0]?.length === 3 &&
    objects[0][0] === definition.refSchema &&
    objects[0][1] === definition.refTable &&
    (typeof objects[0][2] === "string" || typeof objects[0][2] === "number") &&
    /^[1-9]\d*$/.test(String(objects[0][2])) &&
    (typeof objects[0][2] !== "number" || Number.isSafeInteger(objects[0][2]))
  )
    objectId = String(objects[0][2]);
  const keyRows = rows(1);
  let keys: OracleForeignKeyReferenceSnapshot["keys"] = null;
  if (keyRows?.length) {
    const groups = new Map<string, NonNullable<OracleForeignKeyReferenceSnapshot["keys"]>[number]>();
    let valid = true;
    for (const row of keyRows) {
      if (
        row.length !== 7 ||
        typeof row[0] !== "string" ||
        !row[0] ||
        !["P", "U"].includes(String(row[1])) ||
        !["ENABLED", "DISABLED"].includes(String(row[2])) ||
        !["VALIDATED", "NOT VALIDATED"].includes(String(row[3])) ||
        !["DEFERRABLE", "NOT DEFERRABLE"].includes(String(row[4])) ||
        typeof row[5] !== "string" ||
        !row[5]
      ) {
        valid = false;
        break;
      }
      const key = groups.get(row[0]) ?? { name: row[0], kind: String(row[1]), enabled: row[2] === "ENABLED", validated: row[3] === "VALIDATED", deferrable: row[4] === "DEFERRABLE", columns: [] };
      if (key.kind !== row[1] || key.enabled !== (row[2] === "ENABLED") || key.validated !== (row[3] === "VALIDATED") || key.deferrable !== (row[4] === "DEFERRABLE") || key.columns.includes(row[5]) || Number(row[6]) !== key.columns.length + 1) {
        valid = false;
        break;
      }
      key.columns.push(row[5]);
      groups.set(key.name, key);
    }
    if (valid) keys = [...groups.values()];
  }
  const columnRows = rows(2);
  let columns: OracleForeignKeyReferenceSnapshot["columns"] = null;
  if (columnRows?.length && columnRows.every((row) => row.length === 2 && typeof row[0] === "string" && !!row[0] && typeof row[1] === "string" && !!row[1]) && new Set(columnRows.map((row) => row[0])).size === columnRows.length)
    columns = columnRows.map((row) => ({ name: String(row[0]), dataType: String(row[1]) }));
  const tableGrants = rows(3),
    columnGrants = rows(4),
    systemGrants = rows(5);
  const tableReadable = tableGrants !== null && tableGrants.every((row) => row.length === 1 && typeof row[0] === "string");
  const columnsReadable = columnGrants !== null && columnGrants.every((row) => row.length === 2 && typeof row[0] === "string" && typeof row[1] === "string");
  const systemReadable = systemGrants !== null && systemGrants.every((row) => row.length === 1 && typeof row[0] === "string");
  const referencesPresent =
    sameOwner ||
    (tableReadable && tableGrants.some((row) => row[0] === "REFERENCES")) ||
    (columnsReadable && definition.refColumns.every((name) => columnGrants.some((row) => row[0] === name && row[1] === "REFERENCES"))) ||
    (systemReadable && systemGrants.some((row) => row[0] === "REFERENCES ANY TABLE"));
  return { owner: definition.refSchema, table: definition.refTable, objectId, keys, columns, references: referencesPresent ? "present" : tableReadable && columnsReadable && systemReadable ? "missing" : "unknown" };
}

export function parseOracleCanonicalType(raw: string, databaseType: "oracle" | "oceanbase-oracle" = "oracle"): string | null {
  const text = raw.trim().toUpperCase();
  // 1. NUMBER / FLOAT
  if (/^NUMBER(?:\s*\(\s*\d+\s*(?:,\s*-?\d+\s*)?\))?$/.test(text)) return "NUMBER";
  if (/^FLOAT(?:\s*\(\s*\d+\s*\))?$/.test(text)) {
    return databaseType === "oracle" ? "NUMBER" : "FLOAT";
  }
  if (/^BINARY_FLOAT$/.test(text)) return "BINARY_FLOAT";
  if (/^BINARY_DOUBLE$/.test(text)) return "BINARY_DOUBLE";
  // 2. Character types
  if (/^VARCHAR2(?:\s*\(\s*\d+\s*(?:BYTE|CHAR)?\s*\))?$/.test(text)) return "VARCHAR2";
  if (/^VARCHAR(?:\s*\(\s*\d+\s*(?:BYTE|CHAR)?\s*\))?$/.test(text)) {
    return databaseType === "oracle" ? "VARCHAR2" : null;
  }
  if (/^CHAR(?:\s*\(\s*\d+\s*(?:BYTE|CHAR)?\s*\))?$/.test(text)) return "CHAR";
  if (/^NCHAR(?:\s*\(\s*\d+\s*\))?$/.test(text)) return "NCHAR";
  if (/^NVARCHAR2(?:\s*\(\s*\d+\s*\))?$/.test(text)) return "NVARCHAR2";
  // 3. DATE
  if (/^DATE$/.test(text)) return "DATE";
  // 4. RAW
  if (/^RAW(?:\s*\(\s*\d+\s*\))?$/.test(text)) return "RAW";
  // 5. TIMESTAMP
  if (/^TIMESTAMP(?:\s*\(\s*\d+\s*\))?$/.test(text)) return "TIMESTAMP";
  if (/^TIMESTAMP(?:\s*\(\s*\d+\s*\))?\s+WITH\s+LOCAL\s+TIME\s+ZONE$/.test(text)) return "TIMESTAMP_WITH_LOCAL_TIME_ZONE";

  return null;
}

export function compareOracleForeignKeyColumnTypes(localRaw: string, parentRaw: string, databaseType: "oracle" | "oceanbase-oracle" = "oracle"): "compatible" | "incompatible" | "unknown" {
  const localCanonical = parseOracleCanonicalType(localRaw, databaseType);
  const parentCanonical = parseOracleCanonicalType(parentRaw, databaseType);
  if (!localCanonical || !parentCanonical) return "unknown";
  return localCanonical === parentCanonical ? "compatible" : "incompatible";
}

export function validateOracleForeignKeyReference(snapshot: OracleForeignKeyReferenceSnapshot, source: OracleForeignKeySourceSnapshot, definition: OracleForeignKeyDefinition, destructiveReplacement: boolean, databaseType: "oracle" | "oceanbase-oracle" = "oracle"): void {
  if (snapshot.owner !== definition.refSchema || snapshot.table !== definition.refTable) invalid();
  if (destructiveReplacement && (!snapshot.objectId || !snapshot.keys || !snapshot.columns || snapshot.references !== "present")) invalid();
  if (snapshot.columns && definition.refColumns.some((name) => !snapshot.columns!.some((column) => column.name === name))) invalid();
  if (snapshot.keys) {
    const matching = snapshot.keys.filter((key) => key.columns.length === definition.refColumns.length && key.columns.every((name) => definition.refColumns.includes(name)));
    if (!matching.length || (definition.state.enabled && !matching.some((key) => key.enabled))) invalid();
  }
  for (let index = 0; index < definition.columns.length; index++) {
    const local = source.columns.find((column) => column.name === definition.columns[index])?.dataType;
    const parent = snapshot.columns?.find((column) => column.name === definition.refColumns[index])?.dataType;
    if (local && parent) {
      const compatibility = compareOracleForeignKeyColumnTypes(local, parent, databaseType);
      if (compatibility === "incompatible") invalid();
      if (destructiveReplacement && compatibility === "unknown") invalid();
    }
  }
}

export class OracleForeignKeyPreflightError extends Error {
  constructor(readonly reason: "referenceDataInvalid" | "referenceDataUnreadable") {
    super(reason === "referenceDataInvalid" ? "Existing child rows do not match the referenced key." : "Existing rows could not be verified before replacing the foreign key.");
  }
}

export async function checkOracleForeignKeyData(target: OracleForeignKeyTarget, change: OracleForeignKeyChange, destructiveReplacement: boolean, stillCurrent: () => boolean = () => true): Promise<{ checked: boolean }> {
  target = { ...target };
  change = JSON.parse(JSON.stringify(change)) as OracleForeignKeyChange;
  const key = change.target;
  if (!key || !key.state.validated || (change.original?.state.validated && !destructiveReplacement && (change.original.state.enabled || !key.state.enabled))) return { checked: false };
  const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const child = `${ident(target.schema)}.${ident(target.tableName)}`;
  const parent = `${ident(key.refSchema)}.${ident(key.refTable)}`;
  const nonnull = key.columns.map((name) => `fk_child.${ident(name)} IS NOT NULL`).join(" AND ");
  const pairs = key.columns.map((name, index) => `fk_parent.${ident(key.refColumns[index]!)} = fk_child.${ident(name)}`).join(" AND ");
  let rows: unknown[][];
  try {
    rows = await query(target, `SELECT 1 FROM ${child} fk_child WHERE ${nonnull} AND NOT EXISTS (SELECT 1 FROM ${parent} fk_parent WHERE ${pairs}) AND ROWNUM <= 1`, stillCurrent);
  } catch {
    if (destructiveReplacement) throw new OracleForeignKeyPreflightError("referenceDataUnreadable");
    return { checked: false };
  }
  if (rows.length > 1 || rows.some((row) => row.length !== 1 || (row[0] !== 1 && row[0] !== "1"))) {
    if (destructiveReplacement) throw new OracleForeignKeyPreflightError("referenceDataUnreadable");
    return { checked: false };
  }
  if (rows.length) throw new OracleForeignKeyPreflightError("referenceDataInvalid");
  return { checked: true };
}

export interface OracleForeignKeyPlan {
  target: OracleForeignKeyTarget;
  options: BuildTableStructureChangeSqlOptions;
  changes: OracleForeignKeyChange[];
  groups: Array<{ change: OracleForeignKeyChange; statements: string[]; replacement: boolean }>;
  source: OracleForeignKeySourceSnapshot;
  references: Array<{ columns: string[]; snapshot: OracleForeignKeyReferenceSnapshot }>;
  snapshot: string;
  statements: string[];
  unverified: Array<"referenceDefinition" | "referencesPermission" | "existingData">;
}

export interface OracleForeignKeyExecutionResult {
  steps: Array<{ sql: string; state: "committed" | "rejected" | "unknown" | "notExecuted"; error?: string }>;
  readbackError?: string;
  recoverySql?: string[];
}

export interface OracleForeignKeyCreatePlan {
  target: OracleForeignKeyTarget;
  options: BuildTableStructureChangeSqlOptions;
  partitioning?: TablePartitionDefinition;
  changes: OracleForeignKeyChange[];
  statements: string[];
  references: OracleForeignKeyReferenceSnapshot[];
  session: { user: string; currentSchema: string };
  snapshot: string;
  triggerOperations?: OracleTriggerStructureOperation[];
}

export interface OracleForeignKeyCreateExecutionResult {
  steps: Array<{ sql: string; state: "committed" | "rejected" | "unknown" | "notExecuted"; error?: string }>;
  tableExists?: boolean;
  readbackDefinitions?: OracleForeignKeyDefinition[];
  readbackError?: string;
}

/** Preflights every new-table reference before any CREATE statement can run. */
export async function prepareOracleForeignKeyCreatePlan(target: OracleForeignKeyTarget, options: BuildTableStructureChangeSqlOptions, changes: OracleForeignKeyChange[], partitioning?: TablePartitionDefinition, stillCurrent: () => boolean = () => true): Promise<OracleForeignKeyCreatePlan> {
  target = { ...target };
  changes = JSON.parse(JSON.stringify(changes)) as OracleForeignKeyChange[];
  options = { ...JSON.parse(JSON.stringify(options)), databaseType: target.databaseType, schema: target.schema, tableName: target.tableName, foreignKeys: [], oracleForeignKeyChanges: changes };
  if (changes.some((change) => change.original || !change.target)) invalid();
  const generated = partitioning ? await api.buildCreatePartitionedTableSql({ options, partitioning }) : await api.buildCreateTableSql(options);
  if (generated.warnings.length || !generated.statements.length) throw new Error(generated.warnings.join("\n") || "The create plan is empty.");
  if (!/^CREATE\s+TABLE\b/i.test(generated.statements[0]!.trimStart())) invalid();
  if (generated.statements.filter((statement) => statement.includes("FOREIGN KEY")).length !== changes.length) invalid();
  const identity = await query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL", stillCurrent);
  if (identity.length !== 1 || identity[0]?.length !== 2 || identity[0].some((value) => typeof value !== "string" || !value)) invalid();
  const session = { user: identity[0]![0] as string, currentSchema: identity[0]![1] as string };
  const source = {
    user: session.user,
    currentSchema: session.currentSchema,
    objectId: "new-table",
    columns: options.columns.filter((column) => !column.markedForDrop).map((column) => ({ name: column.name, dataType: column.dataType, length: null, precision: null, scale: null, nullable: column.isNullable })),
    definitions: [],
    referenceKeys: [],
    names: [],
  } satisfies OracleForeignKeySourceSnapshot;
  const pkColumns = options.columns.filter((column) => !column.markedForDrop && column.isPrimaryKey).map((column) => column.name);
  const references: OracleForeignKeyReferenceSnapshot[] = [];
  for (const change of changes) {
    const definition = change.target!;
    if (definition.columns.some((name) => !source.columns.some((column) => column.name === name))) invalid();
    const selfReference = foldCreatedTableName(definition.refSchema, target.databaseType) === foldCreatedTableName(target.schema, target.databaseType) && foldCreatedTableName(definition.refTable, target.databaseType) === foldCreatedTableName(target.tableName, target.databaseType);
    if (selfReference) {
      if (definition.refColumns.length !== pkColumns.length || definition.refColumns.some((column) => !pkColumns.includes(column))) invalid();
      const snapshot: OracleForeignKeyReferenceSnapshot = {
        owner: definition.refSchema,
        table: definition.refTable,
        objectId: "new-table",
        keys: pkColumns.length ? [{ name: options.primaryKeyName || "PRIMARY_KEY", kind: "P", enabled: true, validated: true, deferrable: false, columns: pkColumns }] : [],
        columns: source.columns.map(({ name, dataType }) => ({ name, dataType })),
        references: "present",
      };
      validateOracleForeignKeyReference(snapshot, source, definition, false, target.databaseType);
      references.push(snapshot);
      continue;
    }
    const snapshot = await readOracleForeignKeyReferenceSnapshot(target, session.user, definition, stillCurrent);
    validateOracleForeignKeyReference(snapshot, source, definition, false, target.databaseType);
    references.push(snapshot);
  }
  return { target, options, partitioning, changes, statements: [...generated.statements], references, session, snapshot: JSON.stringify({ session, references }), ...(generated.triggerOperations?.length ? { triggerOperations: generated.triggerOperations } : {}) };
}

export async function preflightOracleForeignKeyCreatePlan(plan: OracleForeignKeyCreatePlan, canStart: () => boolean, connectionCurrent: () => boolean): Promise<boolean> {
  if (!canStart() || !connectionCurrent()) return false;
  const fresh = await prepareOracleForeignKeyCreatePlan(plan.target, plan.options, plan.changes, plan.partitioning, connectionCurrent);
  if (!connectionCurrent() || !canStart()) return false;
  if (fresh.snapshot !== plan.snapshot || JSON.stringify(fresh.statements) !== JSON.stringify(plan.statements)) invalid();
  return true;
}

/** Rechecks parent/session state, then executes CREATE and ordered FKs once each. */
export async function executeOracleForeignKeyCreatePlan(plan: OracleForeignKeyCreatePlan, timeoutSecs: number, guards: (() => boolean) | { canStart?: () => boolean; connectionCurrent?: () => boolean }): Promise<OracleForeignKeyCreateExecutionResult | undefined> {
  const canStart = typeof guards === "function" ? guards : (guards.canStart ?? (() => true));
  const connectionCurrent = typeof guards === "function" ? guards : (guards.connectionCurrent ?? (() => true));
  if (!(await preflightOracleForeignKeyCreatePlan(plan, canStart, connectionCurrent))) return undefined;
  const steps: OracleForeignKeyCreateExecutionResult["steps"] = plan.statements.map((sql) => ({ sql, state: "notExecuted" }));
  for (const step of steps) {
    if (!canStart() || !connectionCurrent()) break;
    try {
      const result = await api.executeQuery(plan.target.connectionId, plan.target.database, step.sql.replace(/;\s*$/, ""), plan.target.schema, undefined, { catalog: plan.target.catalog, timeoutSecs });
      if (!connectionCurrent()) {
        step.state = "unknown";
        step.error = "Connection or target changed during execution; outcome is unknown.";
        const outcome: OracleForeignKeyCreateExecutionResult = { steps, readbackError: "Connection or target changed during CREATE DDL; readback is unknown." };
        return outcome;
      }
      if (result.execution_error) {
        step.state = "rejected";
        step.error = result.error?.detail || "Create statement rejected";
        break;
      }
      step.state = "committed";
      if (!canStart()) break;
    } catch (error) {
      step.state = "unknown";
      step.error = error instanceof Error ? error.message : String(error);
      if (!connectionCurrent()) return { steps, readbackError: "Connection or target changed during CREATE DDL; readback is unknown." };
      break;
    }
  }
  return readOracleForeignKeyCreateResult(plan, steps, connectionCurrent);
}

export async function readOracleForeignKeyCreateResult(plan: OracleForeignKeyCreatePlan, steps: OracleForeignKeyCreateExecutionResult["steps"], connectionCurrent: () => boolean): Promise<OracleForeignKeyCreateExecutionResult> {
  const outcome: OracleForeignKeyCreateExecutionResult = { steps };
  const createUnknown = steps[0]?.state === "unknown";
  if (!steps.some((step) => step.state === "committed") && !createUnknown) return outcome;
  if (!connectionCurrent()) {
    outcome.readbackError = "Connection, target, or draft changed before readback; the result remains unknown.";
    return outcome;
  }
  try {
    const readbackTarget = { ...plan.target, tableName: foldCreatedTableName(plan.target.tableName, plan.target.databaseType) };
    const definitions = await readOracleForeignKeyDefinitions(readbackTarget, connectionCurrent);
    if (!connectionCurrent()) {
      outcome.readbackError = "Connection or target changed during readback; the result remains unknown.";
      return outcome;
    }
    outcome.tableExists = true;
    outcome.readbackDefinitions = definitions;
    if (!connectionCurrent()) outcome.readbackError = "Connection or target changed during readback; the result remains unknown.";
    else
      for (const [index, change] of plan.changes.entries()) {
        const expected = change.target!;
        const normalizeCreatedName = (name: string) => (plan.target.databaseType === "oracle" ? foldCreatedTableName(name, plan.target.databaseType) : name);
        const actual = definitions.find((definition) => definition.name === normalizeCreatedName(expected.name));
        const foreignKeyStep = steps.filter((step) => step.sql.includes("FOREIGN KEY"))[index];
        const selfReference = normalizeCreatedName(expected.refSchema) === normalizeCreatedName(plan.target.schema) && normalizeCreatedName(expected.refTable) === normalizeCreatedName(plan.target.tableName);
        const normalizeExpected = (definition: OracleForeignKeyDefinition) => ({
          ...definition,
          name: normalizeCreatedName(definition.name),
          columns: definition.columns.map(normalizeCreatedName),
          ...(selfReference ? { refSchema: normalizeCreatedName(definition.refSchema), refTable: normalizeCreatedName(definition.refTable), refColumns: definition.refColumns.map(normalizeCreatedName) } : {}),
        });
        if (foreignKeyStep?.state === "committed" && JSON.stringify(actual) !== JSON.stringify(normalizeExpected(expected))) {
          outcome.readbackError = "Created foreign key definition differs from the submitted plan.";
          break;
        }
      }
  } catch (error) {
    outcome.readbackError = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

/** Generates a complete preview and its preflight evidence. It never executes generated DDL. */
export async function prepareOracleForeignKeyPlan(target: OracleForeignKeyTarget, options: BuildTableStructureChangeSqlOptions, changes: OracleForeignKeyChange[], stillCurrent: () => boolean = () => true): Promise<OracleForeignKeyPlan> {
  target = { ...target };
  changes = JSON.parse(JSON.stringify(changes)) as OracleForeignKeyChange[];
  options = { ...JSON.parse(JSON.stringify(options)), databaseType: target.databaseType, schema: target.schema, tableName: target.tableName, foreignKeys: [], oracleForeignKeyChanges: changes };
  const whole = await api.buildTableStructureChangeSql(options);
  if (whole.warnings.length) throw new Error(whole.warnings.join("\n"));
  const source = await readOracleForeignKeySourceSnapshot(target, changes, stillCurrent);
  validateOracleForeignKeySourceChanges(source, target, changes);
  const groups: OracleForeignKeyPlan["groups"] = [];
  const references: OracleForeignKeyPlan["references"] = [];
  const referenceIndices = new Map<string, number>();
  const unverified = new Set<OracleForeignKeyPlan["unverified"][number]>();
  const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const reference = async (definition: OracleForeignKeyDefinition) => {
    const identity = JSON.stringify([definition.refSchema, definition.refTable, definition.refColumns]);
    const existing = referenceIndices.get(identity);
    if (existing !== undefined) return references[existing]!.snapshot;
    const snapshot = await readOracleForeignKeyReferenceSnapshot(target, source.user, definition, stillCurrent);
    referenceIndices.set(identity, references.length);
    references.push({
      columns: [...definition.refColumns],
      snapshot: {
        ...snapshot,
        columns: snapshot.columns?.filter((column) => definition.refColumns.includes(column.name)) ?? null,
        keys: snapshot.keys?.filter((key) => key.columns.length === definition.refColumns.length && key.columns.every((column) => definition.refColumns.includes(column))) ?? null,
      },
    });
    return snapshot;
  };
  for (const change of changes) {
    const generated = await api.buildTableStructureChangeSql({ ...options, oracleForeignKeyChanges: [change] });
    if (generated.warnings.length) throw new Error(generated.warnings.join("\n"));
    const originalDrop = change.original ? `ALTER TABLE ${ident(target.schema)}.${ident(target.tableName)} DROP CONSTRAINT ${ident(change.original.name)};` : undefined;
    const replacement = !!change.original && !!change.target && generated.statements[0] === originalDrop;
    groups.push({ change, statements: generated.statements, replacement });
    if (change.original) await reference(change.original);
    if (!change.target || !generated.statements.length) continue;
    const parent = await reference(change.target);
    const needsQualification = !change.original || replacement || (!change.original.state.enabled && change.target.state.enabled) || (!change.original.state.validated && change.target.state.validated);
    if (needsQualification) validateOracleForeignKeyReference(parent, source, change.target, replacement, target.databaseType);
    if (needsQualification && (!parent.objectId || !parent.keys || !parent.columns)) unverified.add("referenceDefinition");
    if (needsQualification && parent.references !== "present") unverified.add("referencesPermission");
    const data = await checkOracleForeignKeyData(target, change, replacement, stillCurrent);
    const needsData = change.target.state.validated && (!change.original || replacement || !change.original.state.validated || (!change.original.state.enabled && change.target.state.enabled));
    if (needsData && !data.checked) unverified.add("existingData");
  }
  const statements = groups.flatMap((group) => group.statements);
  if (JSON.stringify(statements) !== JSON.stringify(whole.statements)) invalid();
  return { target, options, changes, groups, source, references, snapshot: JSON.stringify({ source, references }), statements, unverified: [...unverified] };
}

/** Rechecks the full preflight snapshot, applies one statement at a time, then reads the definitions back. */
export async function executeOracleForeignKeyPlan(plan: OracleForeignKeyPlan, timeoutSecs: number, guards: (() => boolean) | { canStart?: () => boolean; connectionCurrent?: () => boolean }): Promise<OracleForeignKeyExecutionResult | undefined> {
  const canStart = typeof guards === "function" ? guards : (guards.canStart ?? (() => true));
  const connectionCurrent = typeof guards === "function" ? guards : (guards.connectionCurrent ?? (() => true));
  if (!canStart() || !connectionCurrent()) return undefined;
  const fresh = await prepareOracleForeignKeyPlan(plan.target, plan.options, plan.changes, connectionCurrent);
  if (!connectionCurrent() || !canStart()) return undefined;
  if (fresh.snapshot !== plan.snapshot || JSON.stringify(fresh.statements) !== JSON.stringify(plan.statements)) invalid();
  if (!canStart() || !connectionCurrent()) return undefined;
  const steps: OracleForeignKeyExecutionResult["steps"] = plan.statements.map((sql) => ({ sql, state: "notExecuted" }));
  for (const step of steps) {
    if (!canStart() || !connectionCurrent()) break;
    try {
      const result = await api.executeQuery(plan.target.connectionId, plan.target.database, step.sql.replace(/;\s*$/, ""), plan.target.schema, undefined, { catalog: plan.target.catalog, timeoutSecs });
      if (!connectionCurrent()) {
        step.state = "unknown";
        step.error = "Connection or target changed during execution; outcome is unknown.";
        return { steps, readbackError: "Connection or target changed during foreign key DDL; readback is unknown." };
      }
      if (result.execution_error) {
        step.state = "rejected";
        step.error = result.error?.detail || "Foreign key statement rejected";
        break;
      }
      step.state = "committed";
      if (!canStart()) break;
    } catch (error) {
      step.state = "unknown";
      step.error = error instanceof Error ? error.message : String(error);
      if (!connectionCurrent()) return { steps, readbackError: "Connection or target changed during foreign key DDL; readback is unknown." };
      break;
    }
  }
  const outcome: OracleForeignKeyExecutionResult = { steps };
  const recoveryTargets: OracleForeignKeyDefinition[] = [];
  if (!connectionCurrent()) {
    outcome.readbackError = "Connection, target, or draft changed during execution; readback is unknown.";
    return outcome;
  }
  try {
    const current = await readOracleForeignKeyDefinitions(plan.target, connectionCurrent);
    if (!connectionCurrent()) {
      outcome.readbackError = "Connection or target changed during readback; the result remains unknown.";
      return outcome;
    }
    for (const group of plan.groups) {
      const { change, statements } = group;
      if (!statements.length) continue;
      const firstIndex = plan.statements.indexOf(statements[0]!);
      const groupSteps = steps.slice(firstIndex, firstIndex + statements.length);
      const complete = groupSteps.every((step) => step.state === "committed");
      const original = change.original ? current.find((definition) => definition.name === change.original!.name) : undefined;
      const target = change.target ? current.find((definition) => definition.name === change.target!.name) : undefined;
      const matches = (actual: OracleForeignKeyDefinition | undefined, expected: OracleForeignKeyDefinition | null) => !!actual && !!expected && JSON.stringify(actual) === JSON.stringify(expected);
      const dropped = !!change.original && (groupSteps[0]?.state === "committed" || groupSteps[0]?.state === "unknown") && (group.replacement || !change.target);
      if (complete) {
        if (change.target ? !matches(target, change.target) || (change.original && change.original.name !== change.target.name && original) : original) outcome.readbackError = "Foreign key definition differs from the completed statements.";
      } else if (change.original && change.target) {
        if (!matches(original, change.original) && !matches(target, change.target)) outcome.readbackError = "Foreign key definition matches neither the original nor target after a partial change.";
      } else if (change.original) {
        if (groupSteps[0]?.state === "committed" ? !!original : !matches(original, change.original)) outcome.readbackError = "Foreign key removal readback differs from its execution result.";
      } else if (change.target) {
        if (groupSteps[0]?.state === "committed" ? !matches(target, change.target) : !!target) outcome.readbackError = "Foreign key creation readback differs from its execution result.";
      }
      const needsRecovery = dropped && !original && !target && ((complete && !change.target) || groupSteps.some((step) => step.state === "rejected" || step.state === "unknown"));
      if (needsRecovery) {
        if (!canStart() || !connectionCurrent()) {
          outcome.readbackError = "Connection or target changed before recovery checks; the result remains unknown.";
          return outcome;
        }
        const names = await readOracleForeignKeyConstraintNames(plan.target, [change.original!.name, ...(change.target && change.target.name !== change.original!.name ? [change.target.name] : [])], connectionCurrent);
        if (!connectionCurrent()) {
          outcome.readbackError = "Connection or target changed during recovery checks; the result remains unknown.";
          return outcome;
        }
        if (names.length) {
          outcome.readbackError = "A foreign key name is occupied; manual recovery must be reviewed.";
          continue;
        }
        const currentSource = await readOracleForeignKeySourceSnapshot(plan.target, plan.changes, connectionCurrent);
        if (!connectionCurrent()) {
          outcome.readbackError = "Connection or target changed during source verification; the result remains unknown.";
          return outcome;
        }
        const identityMatches = currentSource.user === plan.source.user && currentSource.currentSchema === plan.source.currentSchema && currentSource.objectId === plan.source.objectId;
        const columnsMatch = change.original!.columns.every((colName) => {
          const originalCol = plan.source.columns.find((c) => c.name === colName);
          const currentCol = currentSource.columns.find((c) => c.name === colName);
          return !!originalCol && !!currentCol && originalCol.dataType === currentCol.dataType && originalCol.length === currentCol.length && originalCol.precision === currentCol.precision && originalCol.scale === currentCol.scale && originalCol.nullable === currentCol.nullable;
        });
        if (identityMatches && columnsMatch) {
          recoveryTargets.push(change.original!);
        } else {
          outcome.readbackError = "Table identity or column definitions changed; manual recovery candidate withheld.";
        }
      }
    }
  } catch (error) {
    recoveryTargets.length = 0;
    outcome.readbackError = error instanceof Error ? error.message : String(error);
  }
  if (recoveryTargets.length) {
    if (!canStart() || !connectionCurrent()) {
      outcome.readbackError = "Connection or target changed before generating recovery statements; the result remains unknown.";
      return outcome;
    }
    const recoveryChanges = recoveryTargets.map((original) => ({ original: null, target: original }));
    const recovery = await api.buildTableStructureChangeSql({ ...plan.options, oracleForeignKeyChanges: recoveryChanges });
    if (!canStart() || !connectionCurrent()) {
      outcome.readbackError = "Connection or target changed during recovery statement generation; the result remains unknown.";
      return outcome;
    }
    if (!recovery.warnings.length) outcome.recoverySql = recovery.statements;
  }
  return outcome;
}

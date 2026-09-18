import type { DatabaseType } from "@/types/database";

/** In-dialog state for custom SQL shortcut bodies (fallback + per-DB overrides). */
export type SqlShortcutFormBodies = {
  /** Default fallback template persisted as payload.sql */
  sql: string;
  /** Textarea content for the current editing context */
  body: string;
  databaseTypes: DatabaseType[];
  sqlByDatabaseType: Partial<Record<DatabaseType, string>>;
  editingDatabaseType: DatabaseType | "";
};

/** Stage the current textarea into the override map (scoped) or default sql (all-databases). */
export function flushSqlShortcutEditingBody(form: SqlShortcutFormBodies): SqlShortcutFormBodies {
  if (!form.editingDatabaseType) {
    return { ...form, sql: form.body, sqlByDatabaseType: { ...form.sqlByDatabaseType } };
  }
  return {
    ...form,
    sqlByDatabaseType: { ...form.sqlByDatabaseType, [form.editingDatabaseType]: form.body },
  };
}

/** Flush current body, then load textarea for another selected database. */
export function switchSqlShortcutEditingDatabaseType(form: SqlShortcutFormBodies, next: DatabaseType): SqlShortcutFormBodies {
  const flushed = flushSqlShortcutEditingBody(form);
  return {
    ...flushed,
    editingDatabaseType: next,
    body: flushed.sqlByDatabaseType[next] ?? flushed.sql,
  };
}

export function toggleSqlShortcutFormDatabaseType(form: SqlShortcutFormBodies, dbType: DatabaseType): SqlShortcutFormBodies {
  const flushed = flushSqlShortcutEditingBody(form);
  const removing = flushed.databaseTypes.includes(dbType);
  const nextTypes = removing ? flushed.databaseTypes.filter((item) => item !== dbType) : [...flushed.databaseTypes, dbType];
  const sqlByDatabaseType = { ...flushed.sqlByDatabaseType };

  if (removing) {
    delete sqlByDatabaseType[dbType];
  }

  if (nextTypes.length === 0) {
    // Last scoped DB removed → same as "all databases": keep visible text as the only sql.
    const body = flushed.editingDatabaseType === dbType || !flushed.editingDatabaseType ? flushed.body : (sqlByDatabaseType[flushed.editingDatabaseType] ?? flushed.body);
    return {
      ...flushed,
      databaseTypes: [],
      sqlByDatabaseType: {},
      editingDatabaseType: "",
      sql: body,
      body,
    };
  }

  let editingDatabaseType = flushed.editingDatabaseType;
  if (!editingDatabaseType || !nextTypes.includes(editingDatabaseType)) {
    editingDatabaseType = nextTypes[0]!;
  }

  return {
    ...flushed,
    databaseTypes: nextTypes,
    sqlByDatabaseType,
    editingDatabaseType,
    body: sqlByDatabaseType[editingDatabaseType] ?? flushed.sql,
    sql: flushed.sql,
  };
}

/** Switch back to all-databases: wipe overrides, keep currently visible text as sql. */
export function clearSqlShortcutFormDatabaseTypes(form: SqlShortcutFormBodies): SqlShortcutFormBodies {
  const flushed = flushSqlShortcutEditingBody(form);
  const body = flushed.editingDatabaseType && flushed.sqlByDatabaseType[flushed.editingDatabaseType] != null ? flushed.sqlByDatabaseType[flushed.editingDatabaseType]! : flushed.body;
  return {
    ...flushed,
    databaseTypes: [],
    sqlByDatabaseType: {},
    editingDatabaseType: "",
    sql: body,
    body,
  };
}

/** Copy current textarea to every selected DB override and the default sql. */
export function applySqlShortcutBodyToAllSelected(form: SqlShortcutFormBodies): SqlShortcutFormBodies {
  if (form.databaseTypes.length === 0) {
    return { ...form, sql: form.body, sqlByDatabaseType: {} };
  }
  const sqlByDatabaseType: Partial<Record<DatabaseType, string>> = {};
  for (const dbType of form.databaseTypes) {
    sqlByDatabaseType[dbType] = form.body;
  }
  return {
    ...form,
    sql: form.body,
    sqlByDatabaseType,
  };
}

/** Persistable bodies: default sql + overrides only for still-selected databases. */
export function buildSqlShortcutBodiesForSave(form: SqlShortcutFormBodies): {
  sql: string;
  databaseTypes?: DatabaseType[];
  sqlByDatabaseType?: Partial<Record<DatabaseType, string>>;
} {
  const flushed = flushSqlShortcutEditingBody(form);
  if (flushed.databaseTypes.length === 0) {
    return { sql: flushed.body };
  }
  const sqlByDatabaseType: Partial<Record<DatabaseType, string>> = {};
  for (const dbType of flushed.databaseTypes) {
    const override = flushed.sqlByDatabaseType[dbType];
    if (override != null) sqlByDatabaseType[dbType] = override;
  }
  return {
    sql: flushed.sql,
    databaseTypes: [...flushed.databaseTypes],
    ...(Object.keys(sqlByDatabaseType).length > 0 ? { sqlByDatabaseType } : {}),
  };
}

import type { AnnotationFile, GroupAnnotation, TableAnnotation } from "./types";

/**
 * Every function here returns a NEW file rather than mutating.
 *
 * Empty or whitespace-only prose removes the entry instead of storing "" —
 * the notes file is meant to be committed and reviewed, so it must not
 * accumulate keys holding nothing.
 */
export function emptyAnnotations(): AnnotationFile {
  return { formatVersion: 1 };
}

function blank(value: string): boolean {
  return value.trim() === "";
}

/** Drop a table entry once it carries neither a note nor a group. */
function pruneTable(tables: Record<string, TableAnnotation>, key: string): Record<string, TableAnnotation> {
  const entry = tables[key];
  const empty = entry !== undefined && entry.note === undefined && entry.group === undefined && Object.keys(entry.columns ?? {}).length === 0;
  if (!empty) {
    return tables;
  }
  const { [key]: _dropped, ...rest } = tables;
  return rest;
}

function withTable(file: AnnotationFile, key: string, change: (entry: TableAnnotation) => TableAnnotation): AnnotationFile {
  const tables = { ...file.tables };
  tables[key] = change(tables[key] ?? {});
  const pruned = pruneTable(tables, key);
  return { ...file, tables: Object.keys(pruned).length > 0 ? pruned : undefined };
}

export function setTableNote(file: AnnotationFile, tableKey: string, note: string): AnnotationFile {
  return withTable(file, tableKey, (entry) => {
    const { note: _old, ...rest } = entry;
    return blank(note) ? rest : { ...rest, note };
  });
}

export function setColumnNote(file: AnnotationFile, tableKey: string, column: string, note: string): AnnotationFile {
  return withTable(file, tableKey, (entry) => {
    const columns = { ...entry.columns };
    if (blank(note)) {
      delete columns[column];
    } else {
      columns[column] = { note };
    }
    const { columns: _old, ...rest } = entry;
    return Object.keys(columns).length > 0 ? { ...rest, columns } : rest;
  });
}

export function setTableGroup(file: AnnotationFile, tableKey: string, groupId: string | null): AnnotationFile {
  return withTable(file, tableKey, (entry) => {
    const { group: _old, ...rest } = entry;
    return groupId === null ? rest : { ...rest, group: groupId };
  });
}

export function upsertGroup(file: AnnotationFile, group: GroupAnnotation): AnnotationFile {
  const groups = [...(file.groups ?? [])];
  const index = groups.findIndex((candidate) => candidate.id === group.id);
  if (index >= 0) {
    groups[index] = group;
  } else {
    groups.push(group);
  }
  return { ...file, groups };
}

/**
 * Remove a group and every reference to it.
 *
 * `docsIndex` already drops a dangling groupId when rendering, so the viewer
 * degrades correctly either way — but the committed file should not carry a
 * reference to a group that no longer exists.
 */
export function removeGroup(file: AnnotationFile, groupId: string): AnnotationFile {
  const groups = (file.groups ?? []).filter((group) => group.id !== groupId);
  let next: AnnotationFile = { ...file, groups };
  for (const [key, entry] of Object.entries(file.tables ?? {})) {
    if (entry.group === groupId) {
      next = setTableGroup(next, key, null);
    }
  }
  return next;
}

export function setProjectNote(file: AnnotationFile, note: string): AnnotationFile {
  const project = { ...file.project };
  if (blank(note)) {
    delete project.note;
  } else {
    project.note = note;
  }
  return { ...file, project: Object.keys(project).length > 0 ? project : undefined };
}

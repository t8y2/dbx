import { reactive } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { createAutosave } from "@/components/docs/docsAutosave";
import { emptyAnnotations, removeGroup, setColumnNote, setProjectNote, setTableGroup, setTableNote, upsertGroup } from "@/docs/annotationEdits";
import type { AnnotationFile, DocsEdit, SchemaSnapshot } from "@/docs/types";

/** One docs workspace target: the unit of work a session owns. */
export interface DatabaseDocsSessionConfig {
  connectionId: string;
  database: string;
  schema?: string;
}

export type DatabaseDocsSessionStatus = "running" | "completed" | "failed";

export interface DatabaseDocsSession {
  id: string;
  version: number;
  status: DatabaseDocsSessionStatus;
  config: DatabaseDocsSessionConfig;
  rawSnapshot: SchemaSnapshot | null;
  snapshot: SchemaSnapshot | null;
  annotations: AnnotationFile;
  error: string | null;
}

const sessions = reactive(new Map<string, DatabaseDocsSession>());
/** Autosave + generation control stay outside the reactive record (not serializable). */
const controls = new Map<string, { generation: number; autosave: ReturnType<typeof createAutosave> }>();

function sameConfig(a: DatabaseDocsSessionConfig, b: DatabaseDocsSessionConfig): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && (a.schema || "") === (b.schema || "");
}

function ensureControls(session: DatabaseDocsSession) {
  let control = controls.get(session.id);
  if (!control) {
    control = {
      generation: 0,
      autosave: createAutosave(async (file) => {
        if (!session.config.connectionId) return;
        await api.saveDocsAnnotations(session.config.connectionId, file);
      }, 500),
    };
    controls.set(session.id, control);
  }
  return control;
}

export function findDatabaseDocsSession(config: DatabaseDocsSessionConfig): DatabaseDocsSession | undefined {
  for (const session of sessions.values()) {
    if (sameConfig(session.config, config)) return session;
  }
  return undefined;
}

export function getDatabaseDocsSession(id: string | null | undefined): DatabaseDocsSession | undefined {
  return id ? sessions.get(id) : undefined;
}

/** Returns the session for a config, starting a load when there is none (or the previous one failed). */
export function ensureDatabaseDocsSession(config: DatabaseDocsSessionConfig): DatabaseDocsSession {
  const existing = findDatabaseDocsSession(config);
  if (existing && existing.status !== "failed") {
    ensureControls(existing);
    return existing;
  }
  if (existing) {
    void loadDatabaseDocsSession(existing);
    return existing;
  }
  const session: DatabaseDocsSession = {
    id: uuid(),
    version: 1,
    status: "running",
    config: { ...config },
    rawSnapshot: null,
    snapshot: null,
    annotations: emptyAnnotations(),
    error: null,
  };
  sessions.set(session.id, session);
  ensureControls(session);
  void loadDatabaseDocsSession(session);
  return session;
}

/** Reloads a session from the backend (refresh action). */
export function reloadDatabaseDocsSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  void loadDatabaseDocsSession(session);
}

async function loadDatabaseDocsSession(session: DatabaseDocsSession): Promise<void> {
  // Mutations must go through the reactive map's proxy for consumers to update.
  const live = sessions.get(session.id);
  if (!live) return;
  const control = ensureControls(live);
  const mine = ++control.generation;
  live.status = "running";
  live.error = null;
  live.version++;
  const { connectionId, database, schema } = live.config;
  if (!connectionId || !database) {
    live.status = "failed";
    live.error = "missing connection or database";
    live.version++;
    return;
  }
  try {
    // An absent schema means "everything the collector finds" rather than a
    // filter naming nothing.
    const schemas = schema ? [schema] : [];
    const collected = await api.collectDocsSnapshot(connectionId, database, schemas, [], database);
    const file = (await api.loadDocsAnnotations(connectionId)) ?? emptyAnnotations();
    const merged = await api.applyDocsAnnotations(connectionId, collected, file);
    if (mine !== control.generation) return;
    live.rawSnapshot = collected;
    live.annotations = file;
    live.snapshot = merged;
    live.status = "completed";
    live.version++;
  } catch (error) {
    if (mine !== control.generation) return;
    live.error = error instanceof Error ? error.message : String(error);
    live.status = "failed";
    live.version++;
  }
}

function nextAnnotations(file: AnnotationFile, edit: DocsEdit): AnnotationFile {
  switch (edit.kind) {
    case "projectNote":
      return setProjectNote(file, edit.note);
    case "tableNote":
      return setTableNote(file, edit.tableKey, edit.note);
    case "columnNote":
      return setColumnNote(file, edit.tableKey, edit.column, edit.note);
    case "tableGroup":
      return setTableGroup(file, edit.tableKey, edit.groupId);
    case "upsertGroup":
      return upsertGroup(file, edit.group);
    case "removeGroup":
      return removeGroup(file, edit.groupId);
  }
}

/** Applies an annotation edit, schedules the autosave, and re-derives the merged view. */
export async function applyDatabaseDocsEdit(id: string, edit: DocsEdit): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const control = ensureControls(session);
  const collected = session.rawSnapshot;
  const { connectionId } = session.config;
  if (!connectionId || collected === null) return;
  const file = nextAnnotations(session.annotations, edit);
  session.annotations = file;
  // Schedule before re-deriving: the write must not wait on a display refresh.
  control.autosave.schedule(file);

  const mine = ++control.generation;
  try {
    const merged = await api.applyDocsAnnotations(connectionId, collected, file);
    if (mine === control.generation) {
      session.snapshot = merged;
      session.version++;
    }
  } catch (error) {
    if (mine === control.generation) {
      session.error = error instanceof Error ? error.message : String(error);
      session.version++;
    }
  }
}

/** Flushes a debounced annotation save (dialog close). */
export function flushDatabaseDocsAutosave(id: string): void {
  const control = controls.get(id);
  if (control) void control.autosave.flush();
}

export function databaseDocsAutosaveStatus(id: string | null | undefined) {
  const session = id ? sessions.get(id) : undefined;
  if (!session) return undefined;
  return ensureControls(session).autosave.status;
}

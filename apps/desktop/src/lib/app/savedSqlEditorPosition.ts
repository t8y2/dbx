import * as api from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageRemove } from "@/lib/backend/safeStorage";

export const SAVED_SQL_EDITOR_POSITIONS_STORAGE_KEY = "dbx-saved-sql-editor-positions";

const MAX_SAVED_SQL_EDITOR_POSITIONS = 200;
const ANCHOR_CONTEXT_CHARS = 80;

export interface SavedSqlEditorSelection {
  anchor: number;
  head: number;
}

export interface SavedSqlEditorViewport {
  scrollTop: number;
  scrollLeft: number;
}

export interface SavedSqlEditorPosition {
  savedSqlId: string;
  selection: SavedSqlEditorSelection;
  viewport?: SavedSqlEditorViewport;
  anchor: {
    before: string;
    after: string;
    head: number;
    docLength: number;
  };
  updatedAt: number;
}

function clampOffset(value: number, docLength: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), docLength);
}

function normalizeSelection(selection: SavedSqlEditorSelection | undefined, docLength: number): SavedSqlEditorSelection {
  return {
    anchor: clampOffset(selection?.anchor ?? selection?.head ?? 0, docLength),
    head: clampOffset(selection?.head ?? selection?.anchor ?? 0, docLength),
  };
}

function normalizeViewport(viewport: SavedSqlEditorViewport | undefined): SavedSqlEditorViewport | undefined {
  if (!viewport) return undefined;
  return {
    scrollTop: Math.max(0, Number.isFinite(viewport.scrollTop) ? viewport.scrollTop : 0),
    scrollLeft: Math.max(0, Number.isFinite(viewport.scrollLeft) ? viewport.scrollLeft : 0),
  };
}

function findClosestOccurrence(text: string, query: string, target: number): number | null {
  if (!query) return null;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(query, from);
    if (index < 0) break;
    const distance = Math.abs(index - target);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    from = index + 1;
  }
  return best;
}

function restoredHeadFromAnchor(position: SavedSqlEditorPosition, sql: string): number {
  const targetHead = clampOffset(position.anchor.head, sql.length);
  const before = position.anchor.before;
  const after = position.anchor.after;
  const combined = `${before}${after}`;
  if (combined) {
    const combinedIndex = findClosestOccurrence(sql, combined, Math.max(0, targetHead - before.length));
    if (combinedIndex !== null) return clampOffset(combinedIndex + before.length, sql.length);
  }

  const beforeIndex = findClosestOccurrence(sql, before, Math.max(0, targetHead - before.length));
  if (beforeIndex !== null) return clampOffset(beforeIndex + before.length, sql.length);

  const afterIndex = findClosestOccurrence(sql, after, targetHead);
  if (afterIndex !== null) return clampOffset(afterIndex, sql.length);

  return targetHead;
}

function normalizeSavedPositions(value: unknown): SavedSqlEditorPosition[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SavedSqlEditorPosition => {
    return (
      !!item &&
      typeof item === "object" &&
      typeof item.savedSqlId === "string" &&
      !!item.selection &&
      typeof item.selection.anchor === "number" &&
      typeof item.selection.head === "number" &&
      !!item.anchor &&
      typeof item.anchor.before === "string" &&
      typeof item.anchor.after === "string" &&
      typeof item.anchor.head === "number" &&
      typeof item.anchor.docLength === "number" &&
      typeof item.updatedAt === "number"
    );
  });
}

function parseLegacySavedPositions(): SavedSqlEditorPosition[] {
  const raw = safeLocalStorageGet(SAVED_SQL_EDITOR_POSITIONS_STORAGE_KEY);
  if (!raw) return [];
  try {
    return normalizeSavedPositions(JSON.parse(raw));
  } catch {
    return [];
  }
}

let savedPositions: SavedSqlEditorPosition[] = [];
let savedPositionsLoaded = false;
let savedPositionsInitPromise: Promise<void> | undefined;

export async function initSavedSqlEditorPositions() {
  if (savedPositionsLoaded) return;
  if (savedPositionsInitPromise) return savedPositionsInitPromise;

  savedPositionsInitPromise = (async () => {
    const storedValue = await api.loadSavedSqlEditorPositions().catch(() => null);
    if (Array.isArray(storedValue)) {
      savedPositions = normalizeSavedPositions(storedValue);
      return;
    }

    const legacy = parseLegacySavedPositions();
    if (legacy.length > 0) {
      savedPositions = legacy;
      try {
        await api.saveSavedSqlEditorPositions(trimSavedPositions(legacy));
        // Remove the synchronous startup payload only after the async store
        // accepts the migrated positions.
        safeLocalStorageRemove(SAVED_SQL_EDITOR_POSITIONS_STORAGE_KEY);
      } catch {
        /* keep legacy values for a later migration attempt */
      }
    }
  })().finally(() => {
    savedPositionsLoaded = true;
    savedPositionsInitPromise = undefined;
  });

  return savedPositionsInitPromise;
}

function readSavedPositions(): SavedSqlEditorPosition[] {
  return savedPositions;
}

function trimSavedPositions(positions: SavedSqlEditorPosition[]) {
  return [...positions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED_SQL_EDITOR_POSITIONS);
}

function writeSavedPositions(positions: SavedSqlEditorPosition[]) {
  savedPositions = trimSavedPositions(positions);
  void api.saveSavedSqlEditorPositions(savedPositions).catch(() => {});
}

export function createSavedSqlEditorPosition(input: { savedSqlId: string; sql: string; selection?: SavedSqlEditorSelection; viewport?: SavedSqlEditorViewport; now?: number }): SavedSqlEditorPosition {
  const selection = normalizeSelection(input.selection, input.sql.length);
  const head = selection.head;
  return {
    savedSqlId: input.savedSqlId,
    selection,
    viewport: normalizeViewport(input.viewport),
    anchor: {
      before: input.sql.slice(Math.max(0, head - ANCHOR_CONTEXT_CHARS), head),
      after: input.sql.slice(head, Math.min(input.sql.length, head + ANCHOR_CONTEXT_CHARS)),
      head,
      docLength: input.sql.length,
    },
    updatedAt: input.now ?? Date.now(),
  };
}

export function saveSavedSqlEditorPosition(position: SavedSqlEditorPosition) {
  const next = readSavedPositions().filter((item) => item.savedSqlId !== position.savedSqlId);
  next.unshift(position);
  writeSavedPositions(next);
}

export function restoreSavedSqlEditorPosition(savedSqlId: string, sql: string): { selection?: SavedSqlEditorSelection; viewport?: SavedSqlEditorViewport } {
  const position = readSavedPositions().find((item) => item.savedSqlId === savedSqlId);
  if (!position) return {};

  const restoredHead = restoredHeadFromAnchor(position, sql);
  const originalSelection = normalizeSelection(position.selection, position.anchor.docLength);
  const anchorOffsetFromHead = originalSelection.anchor - originalSelection.head;
  const canReuseViewport = sql.length === position.anchor.docLength && restoredHead === originalSelection.head;
  return {
    selection: {
      anchor: clampOffset(restoredHead + anchorOffsetFromHead, sql.length),
      head: restoredHead,
    },
    viewport: canReuseViewport ? normalizeViewport(position.viewport) : undefined,
  };
}

export function forgetSavedSqlEditorPosition(savedSqlId: string) {
  writeSavedPositions(readSavedPositions().filter((item) => item.savedSqlId !== savedSqlId));
}

export function __resetSavedSqlEditorPositionsForTests(positions: SavedSqlEditorPosition[] = []) {
  savedPositions = trimSavedPositions(positions);
  savedPositionsLoaded = true;
  savedPositionsInitPromise = undefined;
}

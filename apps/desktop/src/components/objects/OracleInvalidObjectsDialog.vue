<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import { AlertTriangle, ChevronDown, Circle, CircleHelp, CircleMinus, CircleX, Clock, Loader2, RefreshCw, Wrench } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { DynamicScroller, DynamicScrollerItem } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { uuid } from "@/lib/common/utils";
import { formatError, normalizeBackendError } from "@/lib/backend/errorUtils";
import { oracleWriteRejected } from "@/lib/database/oracleSecurity";
import {
  oracleCompileUnsupportedReason,
  oracleInvalidObjectSourceKind,
  buildOracleCompileSql,
  buildOracleInvalidObjectsSql,
  buildOracleObjectErrorsSql,
  buildOracleObjectIdentitySql,
  buildOracleObjectStatusSql,
  mapOracleInvalidObjects,
  mapOracleObjectErrors,
  readAllOracleInvalidObjects,
  type OracleInvalidObject,
  type OracleObjectError,
} from "@/lib/database/oracleInvalidObjects";

const props = defineProps<{ open: boolean; connection: ConnectionConfig; database: string; schema: string }>();
const emit = defineEmits<{
  "update:open": [open: boolean];
  "open-source": [object: OracleInvalidObject];
  "compile-finished": [scope: { connectionId: string; database: string; schema: string }];
}>();
const { t } = useI18n();
const objects = ref<OracleInvalidObject[]>([]);
const selected = ref<OracleInvalidObject | null>(null);
const selectedObjects = ref(new Map<string, OracleInvalidObject>());
const currentView = ref<"list" | "detail">("list");
const detailReturnKey = ref("");
const nameFilter = ref("");
const typeFilter = ref<Set<string> | null>(null);
const fullObjects = ref<OracleInvalidObject[]>([]);
const unverifiedKeys = ref(new Set<string>());
const rowResults = ref(new Map<string, BatchItem>());
const fullReadState = ref<"idle" | "reading" | "complete" | "error" | "stopped">("idle");
const fullReadError = ref("");
const fullReadGeneration = ref(0);
const verifyMissingOnNextRead = ref(false);
const errors = ref<OracleObjectError[]>([]);
const errorsTruncated = ref(false);
const loadError = ref("");
const errorLoadError = ref("");
const loading = ref(false);
const compiling = ref(false);
const truncated = ref(false);
const outcome = ref("");
const fullReadCount = ref(0);
const generation = ref(0);
type ManagedSession = { id: string; connectionId: string; database: string; active: number; closeRequested: boolean; closed: boolean };
type ExecutionScope = { connection: ConnectionConfig; connectionKey: string; database: string; schema: string; generation: number; session: ManagedSession };
type BatchStatus = "pending" | "running" | "unsupported" | "valid" | "still-invalid" | "already-valid" | "target-changed" | "deleted" | "failed" | "unknown" | "not-run";
type BatchItem = { object: OracleInvalidObject; sql?: string; unsupportedReason?: "unsupported-type" | "unsupported-on-engine"; status: BatchStatus; message?: string; errors?: OracleObjectError[]; errorsTruncated?: boolean; diagnosticError?: string };
type BatchRun = {
  id: string;
  scope: ExecutionScope;
  state: "running" | "complete";
  readCount: number;
  items: BatchItem[];
  stopRequested: boolean;
  submittedAny: boolean;
  currentName: string;
  readError: string;
  remaining?: OracleInvalidObject[];
  remainingError: string;
};
const batchRun = ref<BatchRun | null>(null);
const batchSupportedCount = computed(() => batchRun.value?.items.filter((item) => !!item.sql).length ?? 0);
const batchSkippedCount = computed(() => batchRun.value?.items.filter((item) => !item.sql || item.status === "not-run").length ?? 0);
const batchHandledCount = computed(() => batchRun.value?.items.filter((item) => item.status !== "pending" && item.status !== "running" && item.status !== "unsupported").length ?? 0);
const batchValidCount = computed(() => batchRun.value?.items.filter((item) => item.status === "valid" || item.status === "already-valid").length ?? 0);
const batchStillInvalidCount = computed(() => batchRun.value?.items.filter((item) => item.status === "still-invalid").length ?? 0);
const batchFailureCount = computed(() => batchRun.value?.items.filter((item) => item.status === "failed" || item.status === "unknown" || item.status === "target-changed" || item.status === "deleted").length ?? 0);
let batchExecutionGeneration = 0;
function newManagedSession(connectionId: string, database: string): ManagedSession {
  return { id: `invalid-objects:${uuid()}`, connectionId, database, active: 0, closeRequested: false, closed: false };
}
let managedSession: ManagedSession | null = null;
let sessionDrainWaiters: Array<() => void> = [];
const displayedObjects = computed(() => objects.value);
const filteredObjects = computed(() => displayedObjects.value.filter(matchesFilters));
const availableTypes = computed(() => [...new Set([...objects.value.map((object) => object.type), ...(typeFilter.value ?? [])])].sort());
const hasFilters = computed(() => nameFilter.value !== "" || typeFilter.value !== null);
const selectedCount = computed(() => selectedObjects.value.size);
const selectedSupportedCount = computed(() => [...selectedObjects.value.values()].filter(canCompileObject).length);
const completeMatchingObjects = computed(() => {
  const completeObjects = new Map(fullObjects.value.map((object) => [selectionKey(object), object]));
  return filteredObjects.value.flatMap((object) => {
    const current = completeObjects.get(selectionKey(object));
    return current && sameObject(object, current) && object.lastDdlTime === current.lastDdlTime && !unverifiedKeys.value.has(selectionKey(object)) ? [current] : [];
  });
});
const allSupportedCount = computed(() => completeMatchingObjects.value.filter(canCompileObject).length);
const allSelectedInFilter = computed(() => {
  const supported = filteredObjects.value.filter(canCompileObject);
  return supported.length > 0 && supported.every((object) => selectedObjects.value.has(selectionKey(object)));
});
const someSelectedInFilter = computed(() => filteredObjects.value.some((object) => selectedObjects.value.has(selectionKey(object))) && !allSelectedInFilter.value);
let singleCompilationGeneration = 0;
let diagnosticGeneration = 0;
let listLoadGeneration = 0;
const databaseType = computed(() => (effectiveDatabaseTypeForConnection(props.connection) ?? props.connection.db_type) as DatabaseType);
type ListCache = { keys: Array<string | number>; sizes: Array<number | null> };
type ListScroller = {
  $el: HTMLElement;
  findItemIndex: (offset: number) => number;
  getItemOffset: (index: number) => number;
  scrollToItem: (index: number, options?: { align: "nearest" }) => void;
  scrollToPosition: (position: number) => void;
  cacheSnapshot: ListCache;
};
type ListViewport = { key: string; index: number; offset: number; focusedKey?: string; focusedControl?: "checkbox" | "name" };
const listScroller = ref<ListScroller | null>(null);
const listCache = shallowRef<ListCache>();
let detailViewport: ListViewport | null = null;
let viewportGeneration = 0;

function isCurrent(token: number): boolean {
  return token === generation.value && props.open;
}

function selectionKey(object: OracleInvalidObject): string {
  return `${object.owner}:${object.objectId}`;
}

function sameObject(left: OracleInvalidObject, right: OracleInvalidObject): boolean {
  return selectionKey(left) === selectionKey(right) && left.name === right.name && left.type === right.type;
}

function renderKey(object: OracleInvalidObject): string {
  return JSON.stringify([object.owner, object.name, object.type, object.objectId]);
}

function matchesFilters(object: OracleInvalidObject): boolean {
  return object.name.toLowerCase().includes(nameFilter.value.toLowerCase()) && (typeFilter.value === null || typeFilter.value.has(object.type));
}

function captureViewport(): ListViewport | null {
  const scroller = listScroller.value;
  if (!scroller || currentView.value !== "list" || filteredObjects.value.length === 0) return null;
  const index = Math.min(Math.max(0, scroller.findItemIndex(scroller.$el.scrollTop)), filteredObjects.value.length - 1);
  const object = filteredObjects.value[index]!;
  const focused = scroller.$el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  return { key: renderKey(object), index, offset: scroller.$el.scrollTop - scroller.getItemOffset(index), focusedKey: focused?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey, focusedControl: focused?.tagName === "INPUT" ? "checkbox" : "name" };
}

async function restoreViewport(viewport: ListViewport | null, focusKey?: string, control: "checkbox" | "name" = "name") {
  if (!viewport) return;
  const requestId = ++viewportGeneration;
  const token = generation.value;
  await nextTick();
  if (!isCurrent(token) || requestId !== viewportGeneration || currentView.value !== "list") return;
  const rows = filteredObjects.value;
  if (rows.length === 0) {
    if (focusKey) document.querySelector<HTMLElement>("[data-list-heading]")?.focus();
    return;
  }
  const anchorIndex = rows.findIndex((object) => renderKey(object) === viewport.key);
  const index = anchorIndex >= 0 ? anchorIndex : Math.min(viewport.index, rows.length - 1);
  listScroller.value?.scrollToPosition(Math.max(0, (listScroller.value?.getItemOffset(index) ?? 0) + viewport.offset));
  if (!focusKey) return;
  const focusIndex = rows.findIndex((object) => renderKey(object) === focusKey);
  const targetIndex = focusIndex >= 0 ? focusIndex : index;
  listScroller.value?.scrollToItem(targetIndex, { align: "nearest" });
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (!isCurrent(token) || requestId !== viewportGeneration || currentView.value !== "list") return;
  const row = Array.from(listScroller.value?.$el.querySelectorAll<HTMLElement>("[data-row-key]") ?? []).find((element) => element.dataset.rowKey === renderKey(rows[targetIndex]!));
  (row?.querySelector<HTMLElement>(control === "checkbox" ? "input:not(:disabled)" : "[data-object-key]") ?? row?.querySelector<HTMLElement>("[data-object-key]") ?? document.querySelector<HTMLElement>("[data-list-heading]"))?.focus({ preventScroll: true });
}

function keepViewport(viewport: ListViewport | null) {
  const focusedRemoved = viewport?.focusedKey && !filteredObjects.value.some((object) => renderKey(object) === viewport.focusedKey);
  void restoreViewport(viewport, focusedRemoved ? viewport.focusedKey : undefined, viewport?.focusedControl);
}

function resetFilterSelection() {
  selectedObjects.value = new Map();
  viewportGeneration++;
  detailViewport = null;
  void nextTick(() => listScroller.value?.scrollToPosition(0));
}

function setNameFilter(value: string | number) {
  if (compiling.value) return;
  resetFilterSelection();
  nameFilter.value = String(value);
}

function setTypeFilter(type: string, checked: boolean) {
  if (compiling.value) return;
  resetFilterSelection();
  const next = new Set(typeFilter.value ?? availableTypes.value);
  if (checked) next.add(type);
  else next.delete(type);
  typeFilter.value = next;
}

function setAllTypes(checked: boolean) {
  if (compiling.value) return;
  resetFilterSelection();
  typeFilter.value = checked ? null : new Set();
}

function clearFilters() {
  if (compiling.value) return;
  resetFilterSelection();
  nameFilter.value = "";
  typeFilter.value = null;
}

function onRowTab(event: KeyboardEvent, object: OracleInvalidObject, control: "checkbox" | "name") {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if ((!event.shiftKey && control === "checkbox") || (event.shiftKey && control === "name" && !compiling.value && canCompileObject(object))) return;
  const index = filteredObjects.value.findIndex((row) => sameObject(row, object)) + (event.shiftKey ? -1 : 1);
  const next = filteredObjects.value[index];
  if (!next) return;
  event.preventDefault();
  const viewport = captureViewport();
  if (!viewport) return;
  const nextControl = !event.shiftKey && !compiling.value && canCompileObject(next) ? "checkbox" : "name";
  void restoreViewport(viewport, renderKey(next), nextControl);
}

function canCompileObject(object: OracleInvalidObject): boolean {
  return !unverifiedKeys.value.has(selectionKey(object)) && !oracleCompileUnsupportedReason(databaseType.value, object.type);
}

function removeValidObject(object: OracleInvalidObject) {
  const viewport = captureViewport();
  objects.value = objects.value.filter((current) => !sameObject(current, object));
  fullObjects.value = fullObjects.value.filter((current) => !sameObject(current, object));
  selectedObjects.value.delete(selectionKey(object));
  unverifiedKeys.value.delete(selectionKey(object));
  rowResults.value.delete(selectionKey(object));
  keepViewport(viewport);
}

function mergeDictionaryRows(rows: OracleInvalidObject[], complete: boolean, acceptChangedIdentity = false) {
  const viewport = captureViewport();
  const incoming = new Map(rows.map((object) => [selectionKey(object), object]));
  const merged: OracleInvalidObject[] = [];
  const unverified = new Set(unverifiedKeys.value);
  for (const previous of objects.value) {
    const key = selectionKey(previous);
    const current = incoming.get(key);
    if (current && sameObject(previous, current)) {
      const result = rowResults.value.get(key);
      const changed = previous.lastDdlTime !== current.lastDdlTime;
      if (result && (changed || unverified.has(key)) && !acceptChangedIdentity) {
        merged.push(previous);
        unverified.add(key);
      } else {
        merged.push(current);
        unverified.delete(key);
      }
      incoming.delete(key);
    } else if (current) {
      // The ID now describes another name/type; require explicit refresh before rebinding it.
      if (acceptChangedIdentity) {
        merged.push(current);
        rowResults.value.delete(key);
        unverified.delete(key);
      } else {
        merged.push(previous);
        unverified.add(key);
      }
      incoming.delete(key);
    } else {
      merged.push(previous);
      if (complete) unverified.add(key);
    }
  }
  merged.push(...incoming.values());
  objects.value = merged;
  unverifiedKeys.value = unverified;
  const current = new Map(merged.map((object) => [selectionKey(object), object]));
  selectedObjects.value = new Map(
    [...selectedObjects.value].filter(([key, previous]) => {
      const refreshed = current.get(key);
      return refreshed && matchesFilters(refreshed) && canCompileObject(refreshed) && sameObject(refreshed, previous) && refreshed.lastDdlTime === previous.lastDdlTime;
    }),
  );
  keepViewport(viewport);
}

function waitForSessionDrain(session: ManagedSession): Promise<void> {
  if (session.active === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (session.active === 0) {
        sessionDrainWaiters = sessionDrainWaiters.filter((waiter) => waiter !== check);
        resolve();
      }
    };
    sessionDrainWaiters.push(check);
  });
}

function ensureManagedSession(connectionId: string, database: string): ManagedSession {
  if (!managedSession || managedSession.connectionId !== connectionId || managedSession.database !== database || managedSession.closeRequested || managedSession.closed) rotateManagedSession(connectionId, database);
  return managedSession!;
}

function captureExecutionScope(): ExecutionScope {
  const connection = { ...props.connection };
  const database = props.database;
  return { connection, connectionKey: JSON.stringify(connection), database, schema: props.schema, generation: generation.value, session: ensureManagedSession(connection.id, database) };
}

function scopeIsCurrent(scope: ExecutionScope): boolean {
  return isCurrent(scope.generation) && props.connection.id === scope.connection.id && JSON.stringify(props.connection) === scope.connectionKey && props.database === scope.database && props.schema === scope.schema;
}

async function query(sql: string, maxRows = 501, scope?: ExecutionScope, allowExecutionError = false) {
  const connectionId = scope?.connection.id ?? props.connection.id;
  const database = scope?.database ?? props.database;
  const schema = scope?.schema ?? props.schema;
  const session = scope?.session ?? ensureManagedSession(connectionId, database);
  session.active++;
  try {
    const result = await api.executeQuery(connectionId, database, sql, schema, undefined, { maxRows, clientSessionId: session.id });
    if (!allowExecutionError && result.execution_error) throw new Error(result.error ? formatError(result.error) : String(result.rows[0]?.[0] ?? "Database query failed"));
    return result;
  } finally {
    session.active--;
    if (session.active === 0) sessionDrainWaiters.slice().forEach((waiter) => waiter());
    closeManagedSession(session);
  }
}

function closeManagedSession(session: ManagedSession) {
  if (!session.closeRequested || session.active > 0 || session.closed) return;
  session.closeRequested = false;
  session.closed = true;
  void api.closeClientConnectionSession(session.connectionId, session.database, session.id).catch(() => undefined);
}

function retireManagedSession() {
  const previous = managedSession;
  managedSession = null;
  if (!previous) return;
  previous.closeRequested = true;
  closeManagedSession(previous);
}

function rotateManagedSession(connectionId: string, database: string) {
  retireManagedSession();
  managedSession = newManagedSession(connectionId, database);
}

function closeCurrentManagedSession() {
  if (!managedSession) return;
  managedSession.closeRequested = true;
  closeManagedSession(managedSession);
}

async function loadList(existingToken?: number, options?: { allowLastDdlTimeChange?: boolean; preserveSelected?: boolean; loadDiagnostics?: boolean }) {
  const token = existingToken ?? ++generation.value;
  const readId = ++listLoadGeneration;
  loading.value = true;
  loadError.value = "";
  if (options?.loadDiagnostics !== false) {
    errorLoadError.value = "";
    errorsTruncated.value = false;
    outcome.value = "";
  }
  try {
    const result = await query(buildOracleInvalidObjectsSql(props.schema, 501), 501);
    if (!isCurrent(token) || readId !== listLoadGeneration) return;
    const rows = mapOracleInvalidObjects(result.rows, props.schema);
    mergeDictionaryRows(rows, false, verifyMissingOnNextRead.value);
    truncated.value = result.truncated === true || rows.length >= 501;
    if (selected.value) {
      const previous = selected.value;
      const refreshed = rows.find((row) => sameObject(row, previous)) ?? null;
      if (!refreshed || refreshed.name !== previous.name || refreshed.type !== previous.type || (!options?.allowLastDdlTimeChange && refreshed.lastDdlTime !== previous.lastDdlTime)) {
        if (refreshed) outcome.value = t("processList.oracleInvalidObjects.targetChanged");
      }
      selected.value = refreshed ?? (options?.preserveSelected ? previous : null);
    }
    if (options?.loadDiagnostics !== false) {
      if (selected.value) await loadErrors(selected.value, token);
      else {
        errors.value = [];
        errorsTruncated.value = false;
      }
    }
    if (isCurrent(token) && readId === listLoadGeneration && !compiling.value) void startFullRead(token);
  } catch (error) {
    if (isCurrent(token) && readId === listLoadGeneration) {
      loadError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (isCurrent(token) && readId === listLoadGeneration) loading.value = false;
  }
}

async function startFullRead(token = generation.value) {
  if (!isCurrent(token) || compiling.value) return;
  const readId = ++fullReadGeneration.value;
  const scope = captureExecutionScope();
  fullReadState.value = "reading";
  fullReadError.value = "";
  fullReadCount.value = 0;
  try {
    const all = await readAllOracleInvalidObjects((sql, maxRows) => query(sql, maxRows, scope), scope.schema, {
      isCurrent: () => isCurrent(token) && fullReadGeneration.value === readId && !compiling.value,
      onProgress: (count) => {
        if (isCurrent(token) && fullReadGeneration.value === readId) fullReadCount.value = count;
      },
    });
    if (!isCurrent(token) || fullReadGeneration.value !== readId || compiling.value) return;
    const verifyMissing = verifyMissingOnNextRead.value;
    verifyMissingOnNextRead.value = false;
    fullObjects.value = all;
    mergeDictionaryRows(all, true, verifyMissing);
    if (verifyMissing) {
      for (const key of unverifiedKeys.value) {
        if (!isCurrent(token) || fullReadGeneration.value !== readId || compiling.value) return;
        const object = objects.value.find((row) => selectionKey(row) === key);
        if (!object) continue;
        try {
          const status = await readObjectStatus(scope, object);
          if (!isCurrent(token) || fullReadGeneration.value !== readId || compiling.value) return;
          const row = status.rows.length === 1 ? status.rows[0] : undefined;
          if (row && String(row[0] ?? "") === object.objectId && String(row[2] ?? "") === "VALID") {
            removeValidObject(object);
          } else if (row && String(row[0] ?? "") === object.objectId && String(row[2] ?? "") === "INVALID") {
            const refreshed = { ...object, lastDdlTime: String(row[1] ?? object.lastDdlTime) };
            objects.value = objects.value.map((current) => (sameObject(current, object) ? refreshed : current));
            fullObjects.value.push(refreshed);
            unverifiedKeys.value.delete(key);
          } else {
            const result = rowResults.value.get(key);
            if (result) {
              result.status = row ? "target-changed" : "deleted";
              result.message = t(row ? "processList.oracleInvalidObjects.batchTargetChanged" : "processList.oracleInvalidObjects.batchDeleted");
            }
          }
        } catch {
          // Keep unconfirmed rows visible and unselectable after a failed read-only check.
        }
      }
    }
    if (!isCurrent(token) || fullReadGeneration.value !== readId || compiling.value) return;
    fullReadState.value = "complete";
  } catch (error) {
    if (!isCurrent(token) || fullReadGeneration.value !== readId || compiling.value) return;
    fullReadState.value = "error";
    fullReadError.value = writeErrorMessage(error);
  }
}

async function loadErrors(object: OracleInvalidObject, token = generation.value) {
  const requestId = ++diagnosticGeneration;
  errorLoadError.value = "";
  errors.value = [];
  errorsTruncated.value = false;
  try {
    const result = await readObjectErrors(captureExecutionScope(), object);
    if (!isCurrent(token) || requestId !== diagnosticGeneration || selectionKey(selected.value ?? object) !== selectionKey(object)) return;
    errors.value = result.errors;
    errorsTruncated.value = result.truncated;
  } catch (error) {
    if (isCurrent(token) && requestId === diagnosticGeneration && selectionKey(selected.value ?? object) === selectionKey(object)) errorLoadError.value = error instanceof Error ? error.message : String(error);
  }
}

function selectObject(object: OracleInvalidObject) {
  diagnosticGeneration++;
  selected.value = object;
  const previousResult = rowBatchItem(object);
  errors.value = previousResult?.errors ?? [];
  errorsTruncated.value = previousResult?.errorsTruncated ?? false;
  errorLoadError.value = previousResult?.diagnosticError ?? "";
  outcome.value = previousResult?.message ?? "";
  if (!compiling.value && !previousResult?.errors?.length && !previousResult?.diagnosticError && !unverifiedKeys.value.has(selectionKey(object))) void loadErrors(object);
}

class BatchWriteError extends Error {
  constructor(
    readonly value: unknown,
    readonly unknown: boolean,
  ) {
    super(writeErrorMessage(value));
  }
}

class IncompleteObjectStatusError extends Error {}

function writeErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && "execution_error" in value) {
    const result = value as { error?: unknown; rows?: unknown[][] };
    return result.error ? formatError(result.error) : String(result.rows?.[0]?.[0] ?? "Database execution failed");
  }
  return formatError(value);
}

function knownWriteRejection(value: unknown): boolean {
  const backendError = normalizeBackendError(value);
  if (backendError?.operationOutcome === "not_started") return true;
  const message = backendError?.detail ?? writeErrorMessage(value);
  return oracleWriteRejected(message, true);
}

function objectIdentityMatches(object: OracleInvalidObject, row: unknown[] | undefined): boolean {
  return !!row && String(row[0] ?? "") === object.objectId && String(row[1] ?? "") === object.lastDdlTime;
}

function objectIdMatches(object: OracleInvalidObject, row: unknown[] | undefined): boolean {
  return !!row && String(row[0] ?? "") === object.objectId;
}

function objectDdlTimeMatches(object: OracleInvalidObject, row: unknown[] | undefined): boolean {
  return !!row && String(row[1] ?? "") === object.lastDdlTime;
}

async function readObjectStatus(scope: ExecutionScope, object: OracleInvalidObject) {
  const result = await query(buildOracleObjectStatusSql(object.owner, object), 2, scope);
  if (result.truncated === true) throw new IncompleteObjectStatusError();
  return result;
}

async function readObjectErrors(scope: ExecutionScope, object: OracleInvalidObject) {
  const result = await query(buildOracleObjectErrorsSql(object.owner, object), 1000, scope);
  return {
    errors: mapOracleObjectErrors(result.rows),
    truncated: result.truncated === true || result.rows.length >= 1000,
  };
}

async function submitCompile(scope: ExecutionScope, sql: string) {
  try {
    const result = await query(sql, 1, scope, true);
    if (result.execution_error) throw new BatchWriteError(result, !knownWriteRejection(result));
    return result;
  } catch (error) {
    if (error instanceof BatchWriteError) throw error;
    throw new BatchWriteError(error, !knownWriteRejection(error));
  }
}

const unsupportedReason = computed(() => (selected.value ? oracleCompileUnsupportedReason(databaseType.value, selected.value.type) : "unsupported-type"));
const singleTargetPresent = computed(() => {
  if (!selected.value) return false;
  return canCompileObject(selected.value) && objects.value.some((object) => sameObject(object, selected.value!));
});

async function compileSingle() {
  const target = selected.value ? { ...selected.value } : null;
  if (!target || unsupportedReason.value || compiling.value) return;
  const scope = captureExecutionScope();
  let sql: string;
  try {
    sql = buildOracleCompileSql(databaseType.value, target.owner, target);
  } catch (error) {
    outcome.value = writeErrorMessage(error);
    return;
  }
  const executionGeneration = ++singleCompilationGeneration;
  const token = scope.generation;
  const connection = scope.connection;
  const database = scope.database;
  const schema = scope.schema;
  const item: BatchItem = reactive({ object: target, sql, status: "pending", errors: [...errors.value], errorsTruncated: errorsTruncated.value, diagnosticError: errorLoadError.value });
  rowResults.value.set(selectionKey(target), item);
  batchRun.value = null;
  let actionSubmitted = false;
  compiling.value = true;
  outcome.value = "";
  listLoadGeneration++;
  diagnosticGeneration++;
  loading.value = false;
  fullReadGeneration.value++;
  if (fullReadState.value === "reading" || fullReadState.value === "complete") fullReadState.value = "stopped";
  try {
    await waitForSessionDrain(scope.session);
    if (!scopeIsCurrent(scope)) return;
    const result = await executeWithProductionSqlGuard({
      connection,
      database: scope.schema,
      sql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        if (!scopeIsCurrent(scope)) throw new Error(t("processList.oracleInvalidObjects.targetChanged"));
        item.status = "running";
        const identity = await query(buildOracleObjectIdentitySql(target.owner, target), 2, scope);
        if (!scopeIsCurrent(scope)) return undefined;
        if (identity.truncated === true || identity.rows.length > 1) {
          item.status = "unknown";
          item.message = t("processList.oracleInvalidObjects.batchIdentityUnknown");
          unverifiedKeys.value.add(selectionKey(target));
          return undefined;
        }
        const row = identity.rows[0];
        if (!objectIdentityMatches(target, row)) {
          item.status = "target-changed";
          unverifiedKeys.value.add(selectionKey(target));
          await loadList(token, { preserveSelected: true, loadDiagnostics: false });
          if (!scopeIsCurrent(scope)) return undefined;
          item.message = t("processList.oracleInvalidObjects.targetChanged");
          return undefined;
        }
        actionSubmitted = true;
        try {
          return await submitCompile(scope, sql);
        } catch (error) {
          if (error instanceof BatchWriteError && !error.unknown) actionSubmitted = false;
          throw error;
        }
      },
    });
    if (!scopeIsCurrent(scope)) return;
    if (result === undefined) {
      if (item.status === "pending") {
        item.status = "not-run";
        item.message = t("processList.oracleInvalidObjects.batchGuardDeclined");
      }
      return;
    }
    const statusResult = await readObjectStatus(scope, target);
    if (!scopeIsCurrent(scope)) return;
    const statusRow = statusResult.rows.length === 1 ? statusResult.rows[0] : undefined;
    // Compilation is DDL and can update LAST_DDL_TIME on the same object.
    // OBJECT_ID distinguishes a replacement; the preflight above still checks both fields.
    const sameObject = statusRow && String(statusRow[0]) === target.objectId;
    const status = sameObject ? String(statusRow[2] ?? "") : "";
    if (sameObject && status === "VALID") {
      item.status = "valid";
      removeValidObject(target);
    } else if (sameObject && status === "INVALID") {
      item.status = "still-invalid";
      updateInvalidObject(item, statusRow!);
    } else {
      item.status = !statusRow ? "deleted" : sameObject ? "unknown" : "target-changed";
      unverifiedKeys.value.add(selectionKey(target));
    }
    if (sameObject && (status === "VALID" || status === "INVALID")) {
      try {
        const diagnostics = await readObjectErrors(scope, target);
        if (!scopeIsCurrent(scope)) return;
        item.errors = diagnostics.errors;
        item.errorsTruncated = diagnostics.truncated;
        item.diagnosticError = "";
      } catch (error) {
        if (!scopeIsCurrent(scope)) return;
        item.diagnosticError = writeErrorMessage(error);
      }
    }
    await loadList(token, { allowLastDdlTimeChange: true, preserveSelected: true, loadDiagnostics: false });
    if (!scopeIsCurrent(scope)) return;
    item.message = !statusRow
      ? t("processList.oracleInvalidObjects.compileGone")
      : !sameObject
        ? t("processList.oracleInvalidObjects.targetChanged")
        : status === "VALID"
          ? t("processList.oracleInvalidObjects.compileValid")
          : status === "INVALID"
            ? t("processList.oracleInvalidObjects.compileStillInvalid")
            : t("processList.oracleInvalidObjects.compileUnknown");
  } catch (error) {
    if (scopeIsCurrent(scope)) {
      if (actionSubmitted) {
        item.status = "unknown";
        unverifiedKeys.value.add(selectionKey(target));
        await loadList(token, { allowLastDdlTimeChange: true, preserveSelected: true, loadDiagnostics: false });
        if (!scopeIsCurrent(scope)) return;
        item.message =
          error instanceof BatchWriteError && !error.unknown
            ? t("processList.oracleInvalidObjects.compileFailed", { message: writeErrorMessage(error.value) })
            : error instanceof IncompleteObjectStatusError
              ? t("processList.oracleInvalidObjects.compileUnknown")
              : `${t("processList.oracleInvalidObjects.compileUnknown")} ${writeErrorMessage(error)}`;
      } else {
        item.status = "failed";
        item.message = t("processList.oracleInvalidObjects.compileFailed", { message: writeErrorMessage(error instanceof BatchWriteError ? error.value : error) });
      }
    }
  } finally {
    if (actionSubmitted) emit("compile-finished", { connectionId: connection.id, database, schema });
    if (singleCompilationGeneration === executionGeneration && scopeIsCurrent(scope)) {
      if (selected.value && sameObject(selected.value, target)) {
        outcome.value = item.message ?? "";
        errors.value = item.errors ?? [];
        errorsTruncated.value = item.errorsTruncated ?? false;
        errorLoadError.value = item.diagnosticError ?? "";
      }
      compiling.value = false;
      if (currentView.value === "detail" && selected.value && !sameObject(selected.value, target) && !unverifiedKeys.value.has(selectionKey(selected.value)) && !rowBatchItem(selected.value)) void loadErrors(selected.value, token);
      void startFullRead(token);
    }
  }
}

function batchIsCurrent(run: BatchRun): boolean {
  return batchRun.value?.id === run.id && scopeIsCurrent(run.scope);
}

function buildBatchItems(objects: OracleInvalidObject[]): BatchItem[] {
  return objects.map((object) => {
    const unsupportedReason = oracleCompileUnsupportedReason(databaseType.value, object.type);
    if (unsupportedReason) return { object, unsupportedReason, status: "unsupported" };
    try {
      return { object, sql: buildOracleCompileSql(databaseType.value, object.owner, object), status: "pending" };
    } catch (error) {
      return { object, unsupportedReason: "unsupported-type", status: "unsupported", message: formatError(error) };
    }
  });
}

function readBatchPlan() {
  void startFullRead();
}

function toggleObjectSelection(object: OracleInvalidObject, checked: boolean) {
  if (compiling.value || unverifiedKeys.value.has(selectionKey(object)) || oracleCompileUnsupportedReason(databaseType.value, object.type)) return;
  const next = new Map(selectedObjects.value);
  if (checked) next.set(selectionKey(object), { ...object });
  else next.delete(selectionKey(object));
  selectedObjects.value = next;
}

function toggleFilteredSelection(checked: boolean) {
  if (compiling.value) return;
  const next = new Map(selectedObjects.value);
  for (const object of filteredObjects.value) {
    if (!canCompileObject(object)) continue;
    const key = selectionKey(object);
    if (checked) next.set(key, { ...object });
    else next.delete(key);
  }
  selectedObjects.value = next;
}

function showDetail(object: OracleInvalidObject) {
  detailViewport = captureViewport();
  listCache.value = listScroller.value?.cacheSnapshot;
  detailReturnKey.value = renderKey(object);
  currentView.value = "detail";
  selectObject(object);
}

function returnFromDetail() {
  currentView.value = "list";
  void restoreViewport(detailViewport, detailReturnKey.value);
}

function refreshCurrentList() {
  if (compiling.value) return;
  fullReadGeneration.value++;
  fullReadState.value = "idle";
  fullReadError.value = "";
  verifyMissingOnNextRead.value = true;
  batchRun.value = null;
  selectedObjects.value = new Map();
  generation.value++;
  void loadList();
}

function stopBatch() {
  const run = batchRun.value;
  if (!run) return;
  if (run.state === "running") run.stopRequested = true;
}

function classifyBatchWriteFailure(error: unknown): "failed" | "unknown" {
  if (error instanceof BatchWriteError) return error.unknown ? "unknown" : "failed";
  return knownWriteRejection(error) ? "failed" : "unknown";
}

async function readBatchObjectErrors(run: BatchRun, item: BatchItem): Promise<void> {
  try {
    const result = await readObjectErrors(run.scope, item.object);
    if (!batchIsCurrent(run)) return;
    item.errors = result.errors;
    item.errorsTruncated = result.truncated;
  } catch (error) {
    if (batchIsCurrent(run)) item.diagnosticError = writeErrorMessage(error);
  }
}

async function refreshBatchRemainder(run: BatchRun) {
  try {
    const remaining = await readAllOracleInvalidObjects((sql, maxRows) => query(sql, maxRows, run.scope), run.scope.schema, { isCurrent: () => scopeIsCurrent(run.scope) });
    if (!batchIsCurrent(run)) return;
    run.remaining = remaining;
    run.remainingError = "";
    fullObjects.value = remaining;
    mergeDictionaryRows(remaining, true);
    fullReadState.value = "complete";
    fullReadError.value = "";
    truncated.value = false;
    loadError.value = "";
  } catch (error) {
    if (!batchIsCurrent(run)) return;
    run.remainingError = writeErrorMessage(error);
    fullReadState.value = "error";
    fullReadError.value = run.remainingError;
    loadError.value = run.remainingError;
  }
}

async function executeBatchItem(run: BatchRun, item: BatchItem): Promise<boolean> {
  const object = item.object;
  if (!batchIsCurrent(run) || !item.sql) return false;
  if (run.stopRequested) {
    item.status = "not-run";
    return false;
  }
  item.status = "running";
  run.currentName = `${object.owner}.${object.name}`;
  let before;
  try {
    before = await readObjectStatus(run.scope, object);
  } catch (error) {
    if (batchIsCurrent(run)) {
      item.status = error instanceof IncompleteObjectStatusError ? "unknown" : "failed";
      item.message = error instanceof IncompleteObjectStatusError ? t("processList.oracleInvalidObjects.batchIdentityUnknown") : writeErrorMessage(error);
      unverifiedKeys.value.add(selectionKey(object));
    }
    return true;
  }
  if (!batchIsCurrent(run)) return false;
  if (run.stopRequested) {
    item.status = "not-run";
    return false;
  }
  if (before.rows.length === 0) {
    item.status = "deleted";
    item.message = t("processList.oracleInvalidObjects.batchDeleted");
    unverifiedKeys.value.add(selectionKey(object));
    return true;
  }
  if (before.rows.length !== 1) {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.batchIdentityUnknown");
    unverifiedKeys.value.add(selectionKey(object));
    return true;
  }
  const beforeStatus = before.rows[0]![2];
  if (!objectIdMatches(object, before.rows[0])) {
    item.status = "target-changed";
    item.message = t("processList.oracleInvalidObjects.batchTargetChanged");
    unverifiedKeys.value.add(selectionKey(object));
    return true;
  }
  if (beforeStatus === "VALID") {
    item.status = "already-valid";
    item.message = t("processList.oracleInvalidObjects.batchAlreadyValid");
    removeValidObject(object);
    return true;
  }
  if (beforeStatus !== "INVALID") {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.batchIdentityUnknown");
    unverifiedKeys.value.add(selectionKey(object));
    return true;
  }
  if (!objectDdlTimeMatches(object, before.rows[0])) {
    item.status = "target-changed";
    item.message = t("processList.oracleInvalidObjects.batchTargetChanged");
    unverifiedKeys.value.add(selectionKey(object));
    return true;
  }
  if (!batchIsCurrent(run) || run.stopRequested) return false;

  const previouslySubmitted = run.submittedAny;
  run.submittedAny = true;
  try {
    await submitCompile(run.scope, item.sql);
  } catch (error) {
    if (!batchIsCurrent(run)) return false;
    const status = classifyBatchWriteFailure(error);
    if (status === "failed") run.submittedAny = previouslySubmitted;
    item.status = status;
    item.message = writeErrorMessage(error);
    if (status === "unknown") unverifiedKeys.value.add(selectionKey(object));
    return status !== "unknown";
  }
  if (!batchIsCurrent(run)) return false;
  let after;
  try {
    after = await readObjectStatus(run.scope, object);
  } catch (error) {
    if (batchIsCurrent(run)) {
      item.status = "unknown";
      item.message = error instanceof IncompleteObjectStatusError ? t("processList.oracleInvalidObjects.compileUnknown") : `${t("processList.oracleInvalidObjects.compileUnknown")} ${writeErrorMessage(error)}`;
      unverifiedKeys.value.add(selectionKey(object));
    }
    return false;
  }
  if (!batchIsCurrent(run)) return false;
  if (after.rows.length === 0) {
    item.status = "deleted";
    item.message = t("processList.oracleInvalidObjects.batchDeleted");
    unverifiedKeys.value.add(selectionKey(object));
    return true;
  }
  if (after.rows.length !== 1) {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.compileUnknown");
    unverifiedKeys.value.add(selectionKey(object));
    return false;
  }
  const [afterId, , afterStatus] = after.rows[0]!;
  if (String(afterId ?? "") !== object.objectId) {
    item.status = "target-changed";
    item.message = t("processList.oracleInvalidObjects.batchTargetChanged");
    unverifiedKeys.value.add(selectionKey(object));
    return true;
  }
  if (afterStatus === "VALID") {
    item.status = "valid";
    item.message = t("processList.oracleInvalidObjects.compileValid");
    removeValidObject(object);
  } else if (afterStatus === "INVALID") {
    item.status = "still-invalid";
    item.message = t("processList.oracleInvalidObjects.compileStillInvalid");
    updateInvalidObject(item, after.rows[0]!);
    await readBatchObjectErrors(run, item);
  } else {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.compileUnknown");
    unverifiedKeys.value.add(selectionKey(object));
    return false;
  }
  return true;
}

async function startBatchCompile(mode: "selected" | "all") {
  if (!props.open || compiling.value || (!managedSession && mode !== "all")) return;
  const stableObjects = objects.value;
  const targets =
    mode === "all"
      ? fullReadState.value === "complete"
        ? completeMatchingObjects.value.map((object) => ({ ...object }))
        : []
      : stableObjects.filter((object) => selectedObjects.value.has(selectionKey(object)) && canCompileObject(object)).map((object) => ({ ...selectedObjects.value.get(selectionKey(object))! }));
  if (targets.length === 0) return;
  const scope = captureExecutionScope();
  const frozenItems = buildBatchItems(targets);
  const executionGeneration = ++batchExecutionGeneration;
  const run: BatchRun = reactive({
    id: uuid(),
    scope,
    state: "running",
    readCount: targets.length,
    items: frozenItems,
    stopRequested: false,
    submittedAny: false,
    currentName: "",
    readError: "",
    remainingError: "",
  });
  batchRun.value = run;
  for (const item of run.items) rowResults.value.set(selectionKey(item.object), item);
  compiling.value = true;
  listLoadGeneration++;
  diagnosticGeneration++;
  loading.value = false;
  fullReadGeneration.value++;
  if (fullReadState.value === "reading" || fullReadState.value === "complete") fullReadState.value = "stopped";
  const queue = run.items.filter((item) => !!item.sql);
  const auditSql = queue.map((item) => item.sql).join(";\n");
  try {
    await waitForSessionDrain(scope.session);
    if (!batchIsCurrent(run)) return;
    const guarded = await executeWithProductionSqlGuard({
      connection: scope.connection,
      database: scope.schema,
      sql: auditSql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        for (const item of queue) {
          if (!batchIsCurrent(run) || run.stopRequested) break;
          const keepGoing = await executeBatchItem(run, item);
          if (!keepGoing) break;
        }
        return true;
      },
    });
    if (!batchIsCurrent(run)) return;
    if (guarded === undefined) {
      for (const item of queue) if (item.status === "pending" || item.status === "running") item.status = "not-run";
      run.readError = t("processList.oracleInvalidObjects.batchGuardDeclined");
    } else {
      for (const item of queue) if (item.status === "pending" || item.status === "running") item.status = "not-run";
    }
    run.state = "complete";
    run.currentName = "";
    await refreshBatchRemainder(run);
  } catch (error) {
    if (!batchIsCurrent(run)) return;
    run.readError = writeErrorMessage(error);
    for (const item of queue) if (item.status === "pending" || item.status === "running") item.status = "not-run";
    run.state = "complete";
    await refreshBatchRemainder(run);
  } finally {
    if (run.submittedAny) emit("compile-finished", { connectionId: scope.connection.id, database: scope.database, schema: scope.schema });
    if (batchExecutionGeneration === executionGeneration && scopeIsCurrent(scope)) compiling.value = false;
  }
}

function batchStatusLabel(status: BatchStatus): string {
  return t(`processList.oracleInvalidObjects.batchStatus.${status}`);
}

function rowBatchItem(object: OracleInvalidObject): BatchItem | undefined {
  const item = rowResults.value.get(selectionKey(object));
  return item && sameObject(item.object, object) ? item : undefined;
}

function updateInvalidObject(item: BatchItem, status: unknown[]) {
  const refreshed = { ...item.object, lastDdlTime: String(status[1] ?? item.object.lastDdlTime) };
  objects.value = objects.value.map((object) => (sameObject(object, item.object) ? refreshed : object));
  item.object = refreshed;
}

function rowStatus(object: OracleInvalidObject): BatchStatus | "invalid" {
  return rowBatchItem(object)?.status ?? (unverifiedKeys.value.has(selectionKey(object)) ? "unknown" : oracleCompileUnsupportedReason(databaseType.value, object.type) ? "unsupported" : "invalid");
}

function rowStatusLabel(object: OracleInvalidObject): string {
  const status = rowStatus(object);
  return status === "invalid" ? "INVALID" : batchStatusLabel(status);
}

function close() {
  generation.value++;
  emit("update:open", false);
}

watch(
  () => [props.open, JSON.stringify(props.connection), props.database, props.schema] as const,
  ([open], previous) => {
    const scopeChanged = !!previous && (previous[1] !== JSON.stringify(props.connection) || previous[2] !== props.database || previous[3] !== props.schema);
    if (scopeChanged || !open) {
      singleCompilationGeneration++;
      batchExecutionGeneration++;
      batchRun.value = null;
      compiling.value = false;
      fullReadGeneration.value++;
      fullReadState.value = "idle";
      fullReadError.value = "";
      fullObjects.value = [];
      unverifiedKeys.value = new Set();
      rowResults.value = new Map();
      verifyMissingOnNextRead.value = false;
      objects.value = [];
      selected.value = null;
      errors.value = [];
      errorsTruncated.value = false;
      diagnosticGeneration++;
      selectedObjects.value = new Map();
      currentView.value = "list";
      nameFilter.value = "";
      typeFilter.value = null;
      listCache.value = undefined;
      detailViewport = null;
      viewportGeneration++;
    }
    if (previous && (previous[1] !== JSON.stringify(props.connection) || previous[2] !== props.database)) retireManagedSession();
    if (open) void loadList();
    else {
      generation.value++;
      objects.value = [];
      errors.value = [];
      errorsTruncated.value = false;
      selected.value = null;
      selectedObjects.value = new Map();
      outcome.value = "";
      closeCurrentManagedSession();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  generation.value++;
  singleCompilationGeneration++;
  batchExecutionGeneration++;
  batchRun.value = null;
  closeCurrentManagedSession();
});
</script>

<template>
  <Dialog :open="open" @update:open="(value) => !value && close()">
    <DialogContent class="h-[min(85vh,760px)] max-h-[min(85vh,760px)] w-[calc(100vw-2rem)] max-w-5xl flex flex-col gap-0 overflow-hidden p-0" @interact-outside="(event) => compiling && event.preventDefault()" @escape-key-down="(event) => compiling && event.preventDefault()">
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <DialogTitle>{{ t("processList.oracleInvalidObjects.title") }} · {{ connection.name }} · {{ schema }}</DialogTitle>
      </DialogHeader>
      <section v-if="currentView === 'list'" class="flex min-h-0 flex-1 flex-col overflow-hidden" :aria-label="t('processList.oracleInvalidObjects.listLabel')" data-list-heading tabindex="-1">
        <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs">
          <span class="text-muted-foreground"
            >{{ hasFilters ? t("processList.oracleInvalidObjects.filterCount", { matched: filteredObjects.length, total: displayedObjects.length }) : t("processList.oracleInvalidObjects.listCount", { count: displayedObjects.length })
            }}<span v-if="fullReadState !== 'complete'"> · {{ t("processList.oracleInvalidObjects.currentlyLoaded") }}</span> · {{ t("processList.oracleInvalidObjects.batchSelectedCount", { count: selectedCount }) }}</span
          >
          <div class="flex flex-wrap items-center gap-1">
            <Button variant="destructive" size="sm" class="h-7 px-2 text-xs" :disabled="selectedSupportedCount === 0 || compiling" @click="startBatchCompile('selected')">{{ t("processList.oracleInvalidObjects.batchCompileSelected", { count: selectedSupportedCount }) }}</Button>
            <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-xs" :disabled="fullReadState !== 'complete' || allSupportedCount === 0 || compiling" @click="startBatchCompile('all')"
              ><Wrench class="h-3.5 w-3.5" />{{
                fullReadState === "complete"
                  ? t(hasFilters ? "processList.oracleInvalidObjects.batchCompileFiltered" : "processList.oracleInvalidObjects.batchCompileAll", { count: allSupportedCount })
                  : t(hasFilters ? "processList.oracleInvalidObjects.compileFiltered" : "processList.oracleInvalidObjects.compileAll")
              }}</Button
            >
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('common.refresh')" :disabled="loading || compiling" @click="refreshCurrentList"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading || fullReadState === 'reading' }" /></Button>
            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="compiling" @click="close">{{ t("common.close") }}</Button>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <label class="flex min-w-40 flex-1 items-center gap-2">
            <span class="shrink-0 text-muted-foreground">{{ t("processList.oracleInvalidObjects.nameFilterLabel") }}</span>
            <Input type="search" class="h-8 text-xs" :model-value="nameFilter" :aria-label="t('processList.oracleInvalidObjects.filterName')" :placeholder="t('processList.oracleInvalidObjects.filterName')" :disabled="compiling" @update:model-value="setNameFilter" />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="h-8 gap-1 text-xs" :disabled="compiling"
                >{{ t("processList.oracleInvalidObjects.filterTypes") }} · {{ typeFilter === null ? t("processList.oracleInvalidObjects.allTypes") : t("processList.oracleInvalidObjects.selectedTypeCount", { count: typeFilter.size }) }}<ChevronDown class="h-3.5 w-3.5"
              /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-44 max-h-72 overflow-y-auto">
              <DropdownMenuCheckboxItem :model-value="typeFilter === null" :disabled="compiling" @select.prevent @update:model-value="setAllTypes($event === true)">{{ t("processList.oracleInvalidObjects.allTypes") }}</DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem v-for="type in availableTypes" :key="type" :model-value="typeFilter === null || typeFilter.has(type)" :disabled="compiling" @select.prevent @update:model-value="setTypeFilter(type, $event === true)">{{ type }}</DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" :disabled="compiling || !hasFilters" @click="clearFilters">{{ t("processList.oracleInvalidObjects.clearFilters") }}</Button>
        </div>
        <p class="shrink-0 border-b px-3 py-1.5 text-[11px] text-muted-foreground">{{ t("processList.oracleInvalidObjects.ddlWarning") }}</p>
        <div v-if="batchRun" class="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 text-xs" role="status" aria-live="polite">
          <span v-if="batchRun.state === 'running'" class="min-w-0 flex-1 break-words">{{
            batchRun.stopRequested ? t("processList.oracleInvalidObjects.batchStopping") : t("processList.oracleInvalidObjects.batchProgress", { handled: batchHandledCount, total: batchSupportedCount, current: batchRun.currentName || t("processList.oracleInvalidObjects.batchRunning") })
          }}</span>
          <span v-else class="min-w-0 flex-1 break-words"
            >{{ t("processList.oracleInvalidObjects.batchSummary", { valid: batchValidCount, stillInvalid: batchStillInvalidCount, failed: batchFailureCount, skipped: batchSkippedCount })
            }}<span v-if="batchRun.remaining"> · {{ t("processList.oracleInvalidObjects.batchRemaining", { count: batchRun.remaining.length }) }}</span
            ><span v-else-if="batchRun.remainingError" class="text-destructive"> · {{ t("processList.oracleInvalidObjects.batchRemainingUnknown", { message: batchRun.remainingError }) }}</span></span
          >
          <Button v-if="batchRun.state === 'running'" variant="outline" size="sm" class="shrink-0" :disabled="batchRun.stopRequested" @click="stopBatch">{{ t("processList.oracleInvalidObjects.batchStop") }}</Button>
        </div>
        <p v-if="batchRun?.readError" class="shrink-0 border-b px-3 py-2 text-xs text-destructive" role="alert">{{ batchRun.readError }}</p>
        <div v-if="loadError" class="m-3 shrink-0 break-words rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{{ loadError }}</div>
        <p v-else-if="fullReadState === 'reading'" class="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">{{ t("processList.oracleInvalidObjects.batchReadProgress", { count: fullReadCount }) }}</p>
        <p v-else-if="fullReadState === 'error'" class="shrink-0 break-words border-b px-3 py-2 text-xs text-destructive" role="alert">
          {{ t("processList.oracleInvalidObjects.batchReadFailed") }} · {{ fullReadError }} <Button variant="ghost" size="sm" class="h-6 px-1" @click="readBatchPlan">{{ t("processList.oracleInvalidObjects.batchRetryRead") }}</Button>
        </p>
        <label class="flex shrink-0 cursor-pointer items-center gap-2 border-b px-4 py-2 text-xs font-medium">
          <input type="checkbox" :checked="allSelectedInFilter" :indeterminate.prop="someSelectedInFilter" :disabled="compiling || !filteredObjects.some(canCompileObject)" @change="toggleFilteredSelection(($event.target as HTMLInputElement).checked)" />
          {{ t("processList.oracleInvalidObjects.batchSelectFiltered") }}
        </label>
        <p v-if="!loading && displayedObjects.length === 0 && !loadError" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ t("processList.oracleInvalidObjects.empty") }}</p>
        <p v-else-if="filteredObjects.length === 0 && displayedObjects.length > 0" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ t("processList.oracleInvalidObjects.noFilterMatches") }}</p>
        <DynamicScroller v-if="filteredObjects.length > 0" ref="listScroller" data-object-scroller class="min-h-0 flex-1 overflow-x-hidden" :items="filteredObjects" :min-item-size="44" :buffer="400" :skip-hover="true" :key-field="renderKey" :cache="listCache">
          <template #default="{ item: object, index, active }">
            <DynamicScrollerItem :item="object" :active="active" :index="index">
              <div :data-row-key="renderKey(object)" :inert="!active" :aria-hidden="!active || undefined" class="flex min-w-0 items-center gap-1 border-b px-2 py-1.5">
                <label class="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    :aria-label="`${object.name} ${object.type}`"
                    :checked="selectedObjects.has(selectionKey(object))"
                    :disabled="compiling || unverifiedKeys.has(selectionKey(object)) || !!oracleCompileUnsupportedReason(databaseType, object.type)"
                    @change="toggleObjectSelection(object, ($event.target as HTMLInputElement).checked)"
                    @keydown.tab="onRowTab($event, object, 'checkbox')"
                  />
                </label>
                <Button
                  variant="ghost"
                  class="h-auto min-w-0 flex-1 justify-start whitespace-normal break-all px-1 py-1 text-left text-xs font-medium"
                  :aria-label="`${object.name} ${object.type}`"
                  :data-object-key="selectionKey(object)"
                  @click="showDetail(object)"
                  @keydown.tab="onRowTab($event, object, 'name')"
                  >{{ object.name }}</Button
                >
                <span class="shrink-0 text-xs text-muted-foreground">{{ object.type }}</span>
                <span role="img" :aria-label="rowStatusLabel(object)" :title="rowStatusLabel(object)" class="inline-flex h-5 w-5 shrink-0 items-center justify-center" :class="rowStatus(object) === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
                  <Loader2 v-if="rowStatus(object) === 'running'" class="h-4 w-4 animate-spin" aria-hidden="true" />
                  <Clock v-else-if="rowStatus(object) === 'pending' || rowStatus(object) === 'not-run'" class="h-4 w-4" aria-hidden="true" />
                  <CircleX v-else-if="rowStatus(object) === 'failed'" class="h-4 w-4" aria-hidden="true" />
                  <CircleHelp v-else-if="rowStatus(object) === 'unknown'" class="h-4 w-4" aria-hidden="true" />
                  <CircleMinus v-else-if="rowStatus(object) === 'unsupported'" class="h-4 w-4" aria-hidden="true" />
                  <Circle v-else-if="rowStatus(object) === 'invalid'" class="h-4 w-4" aria-hidden="true" />
                  <AlertTriangle v-else class="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
        <p v-if="truncated && fullReadState !== 'complete'" class="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.truncated") }}</p>
      </section>
      <section v-else-if="currentView === 'detail' && selected" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
          <div class="min-w-0">
            <div class="break-all text-sm font-semibold">{{ selected.owner }}.{{ selected.name }}</div>
            <div class="mt-1 text-xs text-muted-foreground">{{ selected.type }} · {{ t("processList.oracleInvalidObjects.objectId", { id: selected.objectId }) }}</div>
          </div>
          <Button v-if="oracleInvalidObjectSourceKind(selected.type)" variant="outline" size="sm" class="h-7 shrink-0 gap-1.5 text-xs" :disabled="compiling" @click="emit('open-source', selected)"><Wrench class="h-3.5 w-3.5" />{{ t("processList.oracleInvalidObjects.openSource") }}</Button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
          <div class="mb-2 text-xs font-medium">{{ t("processList.oracleInvalidObjects.errorsTitle") }}</div>
          <div v-if="errorLoadError" class="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{{ errorLoadError }}</div>
          <p v-if="!errorLoadError && errorsTruncated" class="mb-2 rounded border bg-muted/30 p-2 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.errorsTruncated") }}</p>
          <p v-if="!errorLoadError && errors.length === 0 && !compiling" class="py-4 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.noErrors") }}</p>
          <div v-if="!errorLoadError && errors.length > 0" class="overflow-auto rounded border">
            <table class="w-full border-collapse text-xs">
              <thead class="sticky top-0 bg-muted/60">
                <tr>
                  <th class="px-2 py-1.5 text-left">{{ t("processList.oracleInvalidObjects.line") }}</th>
                  <th class="px-2 py-1.5 text-left">{{ t("processList.oracleInvalidObjects.position") }}</th>
                  <th class="px-2 py-1.5 text-left">{{ t("processList.oracleInvalidObjects.message") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="error in errors" :key="error.sequence" class="border-t align-top">
                  <td class="whitespace-nowrap px-2 py-1.5 font-mono">{{ error.line }}</td>
                  <td class="whitespace-nowrap px-2 py-1.5 font-mono">{{ error.position }}</td>
                  <td class="break-words px-2 py-1.5 font-mono">{{ error.text }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="unsupportedReason" class="mt-3 flex items-start gap-2 rounded border bg-muted/30 p-3 text-xs text-muted-foreground">
            <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />{{ t(unsupportedReason === "unsupported-on-engine" ? "processList.oracleInvalidObjects.unsupportedOnEngine" : "processList.oracleInvalidObjects.unsupportedType") }}
          </p>
          <details v-if="selected && !unsupportedReason" class="mt-3 text-xs">
            <summary class="cursor-pointer text-muted-foreground">{{ t("processList.oracleInvalidObjects.batchSqlDetails") }}</summary>
            <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 font-mono">{{ buildOracleCompileSql(databaseType, selected.owner, selected) }}</pre>
          </details>
          <p v-if="outcome" class="mt-3 rounded border bg-muted/20 p-3 text-xs" role="status">{{ outcome }}</p>
        </div>
        <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-4 py-3">
          <Button variant="outline" @click="returnFromDetail">{{ t("processList.oracleInvalidObjects.batchCurrentList") }}</Button>
          <Button variant="outline" :disabled="compiling" @click="close">{{ t("common.close") }}</Button>
          <Button variant="destructive" :disabled="!!unsupportedReason || compiling || !!loadError || !singleTargetPresent" @click="compileSingle"><Loader2 v-if="compiling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />{{ t("processList.oracleInvalidObjects.compile") }}</Button>
        </DialogFooter>
      </section>
    </DialogContent>
  </Dialog>
</template>

import type { EditorView as EditorViewType } from "@codemirror/view";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";
import { findCteColumnResolution, findCteReferenceAt } from "@/lib/sql/semantic/cteNavigation";
import { extractIdentifierDetailsAt, isSqlKeyword, matchSqlObject, matchTable, resolveSqlObjectNavigationIdentity, sqlObjectNavigationTarget, sqlObjectNavigationTargetFromIdentity, sqlObjectNavigationTypeFromCompletionObjectType, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import { matchHoverTableCandidates, resolveHoverTableLookupTarget } from "@/lib/editor/hoverTableLookup";
import { stabilizeUnfocusedQueryEditorPointerDown } from "@/lib/editor/queryEditorUnfocusedPointer";
import { usesQueryEditorObjectNavigationModifier } from "@/lib/editor/queryEditorPointerSelection";
import { queryTableNavigationTargetAtSqlPosition } from "@/lib/sql/queryCursorTableTarget";
import type { SqlCompletionReferencedTable, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import type { Ref, ShallowRef } from "vue";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { useQueryEditorCompletionMetadata } from "./useQueryEditorCompletionMetadata";
import type { QueryEditorCodeMirrorRuntime } from "./queryEditorCodeMirrorRuntime";

interface QueryEditorObjectNavigationOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  editorRef: Readonly<Ref<HTMLElement | null | undefined>>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  metadata: ReturnType<typeof useQueryEditorCompletionMetadata>;
  runtime: QueryEditorCodeMirrorRuntime;
  semanticCompletionEnabled: boolean;
  maxCompletionTables: number;
  dismissHoverTooltip: () => void;
  startEditorSelectionDrag: (view: EditorViewType, event: MouseEvent) => boolean;
  emit: {
    (event: "closeColumnPanel"): void;
    (event: "clickTable", target: SqlObjectNavigationTarget): void;
    (event: "openObjectSource", target: SqlObjectNavigationTarget, initialEditing: boolean): void;
    (event: "clickColumn", columns: Array<{ name: string; table: string; schema?: string }>, error?: string): void;
  };
}

export function useQueryEditorObjectNavigation(options: QueryEditorObjectNavigationOptions) {
  const { props, view, editorRef, settingsStore, connectionStore, metadata: completionMetadata, runtime: codeMirrorRuntime, dismissHoverTooltip, startEditorSelectionDrag, emit } = options;
  const { getEditorSemanticModel, mergeCompletionTables, usesLocalOnlyCompletionMetadata, usesOracleSessionCompletionColumns, completionCacheKey, cachedColumnsByTable, completionMetadataTarget, listCompletionColumnsForEditor } = completionMetadata;
  const SEMANTIC_SQL_COMPLETION_ENABLED = options.semanticCompletionEnabled;
  const MAX_COMPLETION_TABLES = options.maxCompletionTables;
  const tableNavigationHoverClass = "query-editor--table-navigation-hover";

  function jumpToCteRange(target: { from: number; to: number }, highlight: { from: number; to: number }) {
    const currentView = view.value;
    if (!currentView || !codeMirrorRuntime.editorViewModule || !codeMirrorRuntime.setResultSourceRangeEffect) return;
    const docLength = currentView.state.doc.length;
    const targetFrom = Math.max(0, Math.min(target.from, docLength));
    const targetTo = Math.max(targetFrom, Math.min(target.to, docLength));
    const highlightFrom = Math.max(0, Math.min(highlight.from, docLength));
    const highlightTo = Math.max(highlightFrom, Math.min(highlight.to, docLength));
    if (targetFrom >= targetTo) return;
    currentView.dispatch({
      selection: { anchor: targetFrom, head: targetTo },
      effects: [codeMirrorRuntime.setResultSourceRangeEffect.of({ from: highlightFrom, to: highlightTo }), codeMirrorRuntime.editorViewModule.EditorView.scrollIntoView(targetFrom, { y: "center" })],
    });
    currentView.focus();
  }

  function clearTableNavigationHover() {
    editorRef.value?.classList.remove(tableNavigationHoverClass);
  }

  function tableNavigationIdentifierAt(currentView: EditorViewType, event: MouseEvent): string | null {
    if (!props.connectionId || props.database == null) return null;
    const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return null;
    // Identifier extraction only looks around `pos`; slice a small window so
    // modifier-held mouse moves never materialize the whole document string.
    const windowFrom = Math.max(0, pos - 1024);
    const doc = currentView.state.doc;
    const extracted = extractIdentifierDetailsAt(doc.sliceString(windowFrom, Math.min(doc.length, pos + 1024)), pos - windowFrom);
    if (!extracted || (!extracted.quoted && isSqlKeyword(extracted.identifier))) return null;
    return extracted.identifier;
  }

  function updateTableNavigationHover(currentView: EditorViewType, event: MouseEvent) {
    if (!usesQueryEditorObjectNavigationModifier(event)) {
      clearTableNavigationHover();
      return false;
    }
    const identifier = tableNavigationIdentifierAt(currentView, event);
    editorRef.value?.classList.toggle(tableNavigationHoverClass, !!identifier);
    return !!identifier;
  }

  function clearTableNavigationHoverOnModifierRelease(event: KeyboardEvent) {
    if (!usesQueryEditorObjectNavigationModifier(event)) clearTableNavigationHover();
  }

  function onEditorMouseDown(event: MouseEvent) {
    clearTableNavigationHover();
    dismissHoverTooltip();
    const currentView = view.value;
    if (currentView && startEditorSelectionDrag(currentView, event)) {
      return true;
    }
    if (currentView) stabilizeUnfocusedQueryEditorPointerDown(currentView, event);
    // Alt belongs to CodeMirror's rectangular and multi-cursor gestures,
    // even when Cmd/Ctrl is held at the same time.
    if (!usesQueryEditorObjectNavigationModifier(event)) {
      // Click without modifier -> close column panel
      if (!event.metaKey && !event.ctrlKey && event.button === 0) {
        emit("closeColumnPanel");
      }
      return false;
    }
    if (event.button !== 0) return false;

    if (!currentView || !props.connectionId || props.database == null) {
      return false;
    }

    // Use posAtCoords for accurate click position
    const coords = { x: event.clientX, y: event.clientY };
    const pos = currentView.posAtCoords(coords);
    if (pos == null) {
      return false;
    }

    const doc = currentView.state.doc.toString();
    const extracted = extractIdentifierDetailsAt(doc, pos);
    if (!extracted) {
      return false;
    }
    if (!extracted.quoted && isSqlKeyword(extracted.identifier)) {
      return false;
    }
    const identifier = extracted.identifier;

    // Prevent default, resolve async
    event.preventDefault();
    setTimeout(async () => {
      try {
        // Single identity model: quote flags + role (relation column list vs routine call vs unknown).
        const identity = resolveSqlObjectNavigationIdentity(doc, pos);
        if (!identity) return;

        const identifierParts = identity.parts.map((part) => part.value);
        const tableLookupFilter = identity.name;
        const objectNameFilter = identity.name;
        // 3-part schema.package.member; 2-part stays ambiguous until metadata resolves it.
        const objectParentHint = identity.parts.length >= 3 ? identity.qualifier : undefined;
        const objectSchemaHint = identity.parts.length >= 3 ? identity.schema : identity.parts.length === 1 ? props.schema : undefined;
        const isRoutineCall = identity.role === "routine_call";
        const isRelationColumnList = identity.role === "relation_column_list";
        const tableLookup = resolveHoverTableLookupTarget({
          database: props.database!,
          schema: props.schema,
          catalog: props.catalog,
          databaseType: props.databaseType,
          tableName: tableLookupFilter,
          identifierParts,
          mode: settingsStore.editorSettings.tableHoverLookupMode,
        });
        const tableLookupSchema = tableLookup.preferGlobalFirst ? undefined : (tableLookup.schema ?? props.schema);
        const matchNavigationTable = (tables: typeof completionMetadata.cachedTables) =>
          matchHoverTableCandidates(tables, {
            lookups: [identifier],
            tableName: tableLookupFilter,
            preferredSchema: props.schema,
          });
        const relationNavigationTarget = (target: SqlObjectNavigationTarget) =>
          queryTableNavigationTargetAtSqlPosition(
            {
              connectionId: props.connectionId!,
              database: props.database!,
              schema: props.schema,
              databaseType: props.databaseType,
              sql: doc,
              position: pos,
            },
            target,
          );

        // 0. CTE (WITH ... AS) in-editor navigation — jump within the editor instead of
        //    opening metadata for a name that does not exist as a physical table.
        if (SEMANTIC_SQL_COMPLETION_ENABLED) {
          try {
            const cteModel = getEditorSemanticModel(doc, pos, currentView.state);
            if (cteModel) {
              const referenceHit = findCteReferenceAt(cteModel, pos);
              if (referenceHit?.definition.nameSpan) {
                jumpToCteRange({ from: referenceHit.definition.nameSpan.start, to: referenceHit.definition.nameSpan.end }, { from: referenceHit.definition.sourceSpan.start, to: referenceHit.definition.sourceSpan.end });
                return;
              }
              const clickQualifier = identity.parts.length >= 2 ? identity.parts[identity.parts.length - 2]?.value : undefined;
              const columnHit = findCteColumnResolution(cteModel, identity.name, clickQualifier);
              const columnTargetSpan = columnHit?.output?.jumpSpan ?? columnHit?.stars?.[0]?.starSpan;
              if (columnHit && columnTargetSpan) {
                jumpToCteRange({ from: columnTargetSpan.start, to: columnTargetSpan.end }, { from: columnHit.definition.sourceSpan.start, to: columnHit.definition.sourceSpan.end });
                return;
              }
            }
          } catch (error) {
            console.warn("[DBX] CTE ctrl+click resolution failed:", error);
          }
        }

        // 1. Local table lookup with the resolved scope (do not trust stale editor cache alone —
        // completion/hover may have filled cachedTables with the current schema only).
        const localScopedTables = connectionStore.lookupLocalCompletionTables(props.connectionId!, tableLookup.database, tableLookupFilter, MAX_COMPLETION_TABLES, tableLookupSchema, props.catalog);
        completionMetadata.cachedTables = mergeCompletionTables(localScopedTables, completionMetadata.cachedTables);
        let matchedTable = matchNavigationTable(localScopedTables);
        if (matchedTable) {
          emit("clickTable", relationNavigationTarget(matchedTable));
          return;
        }

        if (!matchedTable && tableLookup.allowGlobalFallback && !tableLookup.preferGlobalFirst) {
          const localGlobalTables = connectionStore.lookupLocalCompletionTables(props.connectionId!, tableLookup.database, tableLookupFilter, MAX_COMPLETION_TABLES, undefined, props.catalog);
          completionMetadata.cachedTables = mergeCompletionTables(completionMetadata.cachedTables, localGlobalTables);
          matchedTable = matchNavigationTable(localGlobalTables);
          if (matchedTable) {
            emit("clickTable", relationNavigationTarget(matchedTable));
            return;
          }
        }

        const preserveOracleStoreCase = (value?: string) => !!value && value !== value.toUpperCase();
        const openMatchedObject = (matchedObject: { name: string; schema?: string; type: string; signature?: string; parentName?: string; parentSchema?: string }) => {
          const navigationType = sqlObjectNavigationTypeFromCompletionObjectType(matchedObject.type);
          if (!navigationType) return false;
          // Metadata names are store-correct; mark mixed-case (or click-quoted) so Oracle normalize won't force UPPER.
          emit(
            "openObjectSource",
            sqlObjectNavigationTarget({
              name: matchedObject.name,
              schema: matchedObject.schema,
              type: navigationType,
              signature: matchedObject.signature,
              parentName: matchedObject.parentName,
              parentSchema: matchedObject.parentSchema,
              nameQuoted: identity.nameQuoted || preserveOracleStoreCase(matchedObject.name),
              schemaQuoted: matchedObject.schema ? identity.schemaQuoted || identity.qualifierQuoted || preserveOracleStoreCase(matchedObject.schema) : undefined,
              parentNameQuoted: matchedObject.parentName ? identity.qualifierQuoted || preserveOracleStoreCase(matchedObject.parentName) : undefined,
              parentSchemaQuoted: matchedObject.parentSchema ? identity.schemaQuoted || preserveOracleStoreCase(matchedObject.parentSchema) : undefined,
            }),
            false,
          );
          return true;
        };

        // 1b. Local routine cache — skip for pure relation column lists (INSERT INTO t(...)).
        if (!isRelationColumnList) {
          const localObjects = connectionStore.lookupLocalCompletionObjects(props.connectionId!, props.database!, objectNameFilter, MAX_COMPLETION_TABLES, props.schema);
          let matchedObject = matchSqlObject(identifier, localObjects);
          if (matchedObject && openMatchedObject(matchedObject)) return;

          if (!usesLocalOnlyCompletionMetadata()) {
            // Disambiguate schema.routine vs package.member with small scoped lookups (no global scan).
            if (identity.parts.length === 2 && identity.qualifier) {
              // Prefer package.member under session schema (Oracle common: PKG.MEMBER()).
              const packageObjects = await connectionStore.listCompletionObjects(props.connectionId!, props.database!, objectNameFilter, 20, props.schema, identity.qualifier, false, props.schema, ["routine"]);
              matchedObject = matchSqlObject(identifier, packageObjects);
              if (matchedObject && openMatchedObject(matchedObject)) return;

              // Then schema.routine with qualifier as owner.
              const schemaObjects = await connectionStore.listCompletionObjects(props.connectionId!, props.database!, objectNameFilter, 20, identity.qualifier, undefined, false, props.schema, ["routine"]);
              matchedObject = matchSqlObject(identifier, schemaObjects);
              if (matchedObject && openMatchedObject(matchedObject)) return;
            } else {
              const scopedObjects = await connectionStore.listCompletionObjects(props.connectionId!, props.database!, objectNameFilter, 20, objectSchemaHint, objectParentHint, false, props.schema, ["routine"]);
              matchedObject = matchSqlObject(identifier, scopedObjects);
              if (matchedObject && openMatchedObject(matchedObject)) return;
            }
          }
        }

        // 1c. Remote table metadata — never skip for relation column lists or unknown identifiers.
        // Routine-call sites may still hit this when a table and procedure share a name and
        // local caches were empty; table wins only if listed as a relation.
        if (!usesLocalOnlyCompletionMetadata() && (!isRoutineCall || isRelationColumnList || identity.role === "unknown")) {
          completionMetadata.cachedTables = await connectionStore.listCompletionTables(props.connectionId!, tableLookup.database, tableLookupFilter, MAX_COMPLETION_TABLES, tableLookupSchema, tableLookup.preferGlobalFirst, props.schema, props.catalog);
          matchedTable = matchNavigationTable(completionMetadata.cachedTables);
          if (matchedTable) {
            emit("clickTable", relationNavigationTarget(matchedTable));
            return;
          }
          if (tableLookup.allowGlobalFallback && !tableLookup.preferGlobalFirst) {
            const globalTables = await connectionStore.listCompletionTables(props.connectionId!, tableLookup.database, tableLookupFilter, MAX_COMPLETION_TABLES, undefined, true, props.schema, props.catalog);
            completionMetadata.cachedTables = mergeCompletionTables(completionMetadata.cachedTables, globalTables);
            matchedTable = matchNavigationTable(completionMetadata.cachedTables);
            if (matchedTable) {
              emit("clickTable", relationNavigationTarget(matchedTable));
              return;
            }
          }
        } else if (!usesLocalOnlyCompletionMetadata() && isRoutineCall) {
          // Lightweight table check so INSERT INTO ORDERS(…) is not the only guarded path —
          // still avoid unbounded scans: session-scoped first, optional name-filtered global fallback.
          completionMetadata.cachedTables = await connectionStore.listCompletionTables(props.connectionId!, tableLookup.database, tableLookupFilter, 20, tableLookupSchema, tableLookup.preferGlobalFirst, props.schema, props.catalog);
          matchedTable = matchNavigationTable(completionMetadata.cachedTables);
          if (matchedTable) {
            emit("clickTable", relationNavigationTarget(matchedTable));
            return;
          }
          if (tableLookup.allowGlobalFallback && !tableLookup.preferGlobalFirst) {
            const globalTables = await connectionStore.listCompletionTables(props.connectionId!, tableLookup.database, tableLookupFilter, 20, undefined, true, props.schema, props.catalog);
            completionMetadata.cachedTables = mergeCompletionTables(completionMetadata.cachedTables, globalTables);
            matchedTable = matchNavigationTable(completionMetadata.cachedTables);
            if (matchedTable) {
              emit("clickTable", relationNavigationTarget(matchedTable));
              return;
            }
          }
        }

        // 1d. Optimistic routine open only for confirmed call sites after metadata + table checks.
        if (isRoutineCall) {
          const optimistic = sqlObjectNavigationTargetFromIdentity(identity, {
            fallbackSchema: props.schema,
            preferType: "procedure",
            // 2-part: package.member under session schema (not schema.routine).
            asPackageMember: identity.twoPartAmbiguous,
          });
          if (optimistic) {
            emit("openObjectSource", optimistic, false);
            return;
          }
        }

        // 2. Parse SQL at click position to get referenced tables
        const context = getSqlCompletionContext(doc, pos);
        let referencedTables: Array<SqlCompletionReferencedTable & Pick<SqlCompletionTable, "type">> = context.referencedTables;
        // Enrich referenced tables with schema from cachedTables
        referencedTables = referencedTables.map((rt) => {
          if (usesOracleSessionCompletionColumns(rt.schema)) return rt;
          const cached = completionMetadata.cachedTables.find((ct) => ct.name.toLowerCase() === rt.name.toLowerCase() && (!rt.schema || !ct.schema || ct.schema.toLowerCase() === rt.schema.toLowerCase()));
          if (!cached) return rt;
          return {
            ...rt,
            ...(!rt.schema && cached.schema ? { schema: cached.schema } : {}),
            ...(cached.type ? { type: cached.type } : {}),
          };
        });

        // Check if identifier has a qualifier (e.g., c.card_name or schema.table)
        const qualifier = identifierParts.length >= 2 ? identifierParts[identifierParts.length - 2] : null;

        const matchedRef = matchTable(identifier, referencedTables);
        if (matchedRef) {
          emit("clickTable", relationNavigationTarget(matchedRef));
          return;
        }
        const colName = identifierParts[identifierParts.length - 1] ?? identifier;
        const colLower = colName.toLowerCase();

        if (referencedTables.length === 0) {
          return;
        }
        // 3. Fetch columns — if qualifier, only check matching table; otherwise check all
        const tablesToCheck = qualifier ? referencedTables.filter((rt) => rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase()) : referencedTables;

        if (tablesToCheck.length === 0 && qualifier) {
          return;
        }

        const matchedCols: Array<{
          name: string;
          table: string;
          schema?: string;
        }> = [];

        for (const refTable of tablesToCheck) {
          const cacheKey = completionCacheKey(refTable);

          // Use persistent column cache; fetch only if missing
          let cols = cachedColumnsByTable.get(cacheKey);
          if (!cols) {
            try {
              const target = completionMetadataTarget(refTable);
              if (!target) continue;
              cols = await listCompletionColumnsForEditor(props.connectionId!, target.database, refTable.name, target.schema, target.catalog, refTable);
              cachedColumnsByTable.set(cacheKey, cols);
            } catch {
              continue;
            }
          }
          for (const col of cols) {
            if (col.name.toLowerCase() === colLower) {
              matchedCols.push({
                name: col.name,
                table: refTable.name,
                schema: col.schema || refTable.schema,
              });
            }
          }
        }

        if (matchedCols.length > 0) {
          emit("clickColumn", matchedCols);
        }
      } catch (e) {
        console.error("[DBX] Ctrl+click error:", e);
      }
    }, 0);
    return true;
  }

  function attach() {
    window.addEventListener("keyup", clearTableNavigationHoverOnModifierRelease);
    window.addEventListener("blur", clearTableNavigationHover);
  }

  function dispose() {
    window.removeEventListener("keyup", clearTableNavigationHoverOnModifierRelease);
    window.removeEventListener("blur", clearTableNavigationHover);
  }

  return { clearTableNavigationHover, updateTableNavigationHover, onEditorMouseDown, attach, dispose };
}

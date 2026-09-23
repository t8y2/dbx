import { type RoutineCompletionTarget } from "./useQueryEditorCompletionMetadata";
import { computed } from "vue";
import type { CompletionContext } from "@codemirror/autocomplete";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { type QueryCompletionItem, type BatchColumnSelectionActionItem } from "./useQueryEditorBatchSelection";
import type { CompletionMetadataScope } from "./queryEditorTypes";
import { completionMatchRanges } from "@/lib/common/completionMatch";
import {
  buildSqlCompletionItemsFromContext,
  buildPostgresSequenceLiteralCompletionItems,
  getSqlCompletionContext,
  getPostgresSequenceLiteralCompletionContext,
  getSqlCompletionResultValidFor,
  isSqlCompletionSuppressedContext,
  isSqlLikeCompletionStatement,
  prepareSqlCompletionReplacement,
  recordCompletionSelection,
  shouldAutoOpenSqlCompletion,
  shouldChainSqlCompletionAfterAccept,
  extractCteDefinitions,
} from "@/lib/sql/sqlCompletion";
import { originForSqlCompletionProvider, originForTypedSqlCompletionStart, shouldAllowSqlCompletionTrigger, type SqlCompletionTriggerFacts, type SqlCompletionTriggerOrigin } from "@/lib/sql/sqlCompletionTriggerPolicy";
import { driverProfileHasCompletionCandidates } from "@/lib/database/driverProfileExtensions";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { buildElasticsearchCompletionItemsFromContext, elasticsearchCompletionNeedsFields, getElasticsearchCompletionContext, getElasticsearchCompletionResultValidFor, shouldAutoOpenElasticsearchCompletion, type ElasticsearchCompletionField } from "@/lib/elasticsearch/elasticsearchCompletion";
import { buildMongoCompletionItemsFromContext, getMongoCompletionContext, getMongoCompletionResultValidFor, mongoCompletionNeedsCollections, mongoCompletionNeedsFields, shouldAutoOpenMongoCompletion } from "@/lib/mongo/mongoCompletion";
import {
  buildSqlServerUseDatabaseCompletionItems,
  mergeSqlCompletionQualifierNames,
  resolveSqlCompletionRoutineLookupTarget,
  resolveSqlCompletionSchemaLookupDatabase,
  resolveSqlCompletionScope,
  resolveSqlCompletionTableLookupTarget,
  resolveSqlServerUseDatabaseCompletion,
  sqlServerUseCompletionDatabaseNames,
  sqlServerUseDatabaseBeforeCursor,
} from "@/lib/sql/sqlCompletionLookupTarget";
import { appendSqlCompletionSpace } from "@/lib/editor/sqlCompletionInsertion";
import { completionReplacementTo, shouldResolveSqlColumnCompletion } from "@/lib/editor/batchColumnSelection";
import { completionLabelPresentation } from "@/lib/editor/sqlCompletionPresentation";
import { supportsDatabaseNameCompletion } from "@/lib/database/databaseFeatureSupport";
import { sqlSnippetDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { oracleDatabaseLinkCompletionContext, oracleDatabaseLinkCompletionItems } from "@/lib/sql/oracleDatabaseLinkCompletion";
import { buildRedisCompletionItemsFromContext, getRedisCompletionContext, getRedisCompletionResultValidFor, shouldAutoOpenRedisCompletion, takesKeyArgument } from "@/lib/redis/redisCompletion";
import type { SqlCompletionColumn, SqlCompletionContext, SqlCompletionForeignKey, SqlCompletionItem, SqlCompletionObject } from "@/lib/sql/sqlCompletion";
import type { CompletionAssistantObjectKind, SqlServerCompletionContext } from "@/types/database";
import type { ShallowRef, ComputedRef } from "vue";
import type { Composer } from "vue-i18n";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { useQueryEditorBatchSelection } from "./useQueryEditorBatchSelection";
import type { useQueryEditorCompletionMetadata } from "./useQueryEditorCompletionMetadata";
import type { QueryEditorProps } from "./queryEditorTypes";

interface QueryEditorCompletionRuntime {
  codeMirrorCompletionStatus: typeof import("@codemirror/autocomplete").completionStatus | null;
  codeMirrorInsertCompletionText: typeof import("@codemirror/autocomplete").insertCompletionText | null;
  codeMirrorSnippetCompletion: typeof import("@codemirror/autocomplete").snippetCompletion;
  codeMirrorStartCompletion: typeof import("@codemirror/autocomplete").startCompletion | null;
  imeCompositionActive: boolean;
}
interface QueryEditorCompletionOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  sqlDriverProfile: ComputedRef<string | undefined>;
  t: Composer["t"];
  metadata: ReturnType<typeof useQueryEditorCompletionMetadata>;
  batchSelection: ReturnType<typeof useQueryEditorBatchSelection>;
  runtime: QueryEditorCompletionRuntime;
  isEditorComposing: (view: EditorViewType) => boolean;
  debounceDelayMs: number;
  triggerDeferDelayMs: number;
  maxCompletionTables: number;
  onDemandTableLimit: number;
  semanticCompletionEnabled: boolean;
}

export function useQueryEditorCompletion(options: QueryEditorCompletionOptions) {
  const { props, view, connectionStore, settingsStore, sqlDriverProfile, t, runtime, isEditorComposing } = options;
  const completionMetadata = options.metadata;
  const {
    supportsDatabaseSchemaQualifierCompletion,
    sqlCompletionDialectOptions,
    getEditorSqlCompletionContext,
    supportsDatabaseQualifierCompletion,
    completionObjectsForScope,
    usesOracleSessionCompletionColumns,
    completionCacheKey,
    completionQualifiedTableTarget,
    completionTablesMatch,
    lookupCachedPrefixColumns,
    cachedColumnsByTable,
    completionMetadataTarget,
    completionColumnRequestContext,
    isVirtualCompletionTableReference,
    cachedForeignKeysByTable,
    usesLocalOnlyCompletionMetadata,
    usesOnDemandOnlyCompletionColumns,
    mergeCompletionTables,
    ensureForeignKeysForTables,
    mergeCompletionObjects,
    completionObjectsDiffer,
    cachedCompletionObjectsByScope,
    completionObjectScopeKey,
    refreshCompletionColumnsForEditor,
    listCompletionColumnsForEditor,
    listCompletionTablesWithLatencyBudget,
    allowsOnDemandQualifiedTableCompletion,
    completionPrefixCacheKey,
    cachedPrefixColumnsByTable,
  } = completionMetadata;
  const { clearBatchColumnSelectionSession, prepareBatchColumnSelectionSession, batchColumnSelectionAllSelected, isBatchColumnSelectionAction, toggleAllBatchColumnSelection, applyBatchColumnSelection, batchColumnSelectionMarkerForItem, cacheBatchColumnSelectionOption } = options.batchSelection;
  const COMPLETION_DEBOUNCE_DELAY_MS = options.debounceDelayMs;
  const COMPLETION_TRIGGER_DEFER_DELAY_MS = options.triggerDeferDelayMs;
  const MAX_COMPLETION_TABLES = options.maxCompletionTables;
  const PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT = options.onDemandTableLimit;
  const SEMANTIC_SQL_COMPLETION_ENABLED = options.semanticCompletionEnabled;

  const snippetDatabaseType = computed(() => {
    const connection = props.connectionId ? connectionStore.getConfig(props.connectionId) : undefined;
    return sqlSnippetDatabaseTypeForConnection(connection) ?? props.databaseType;
  });

  const SQL_FUNCTION_NAMES = [
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "GROUP_CONCAT",
    "STRING_AGG",
    "CONCAT",
    "CONCAT_WS",
    "SUBSTRING",
    "REPLACE",
    "TRIM",
    "UPPER",
    "LOWER",
    "LENGTH",
    "REGEXP_REPLACE",
    "DATE_FORMAT",
    "DATEDIFF",
    "DATE_ADD",
    "DATE_SUB",
    "EXTRACT",
    "NOW",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "CURDATE",
    "CURTIME",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "UTC_DATE",
    "UTC_TIME",
    "UTC_TIMESTAMP",
    "SYSDATE",
    "DATE",
    "TIME",
    "TIMESTAMPDIFF",
    "YEAR",
    "MONTH",
    "DAY",
    "HOUR",
    "MINUTE",
    "SECOND",
    "DAYOFWEEK",
    "DAYOFYEAR",
    "LAST_DAY",
    "STR_TO_DATE",
    "IF",
    "LEFT",
    "RIGHT",
    "SUBSTRING_INDEX",
    "CHAR_LENGTH",
    "INSTR",
    "LOCATE",
    "LPAD",
    "RPAD",
    "FIND_IN_SET",
    "RAND",
    "MD5",
    "SHA1",
    "SHA2",
    "ROUND",
    "FLOOR",
    "CEIL",
    "ABS",
    "MOD",
    "COALESCE",
    "IFNULL",
    "NULLIF",
    "CAST",
    "JSON_EXTRACT",
    "JSON_VALUE",
    "JSON_OBJECT",
    "JSON_ARRAY",
  ] as const;

  const completionTranslations = computed(() => ({
    nullValue: t("editor.completion.nullValue"),
    isNull: t("editor.completion.isNull"),
    isNotNull: t("editor.completion.isNotNull"),
    stringLiteral: t("editor.completion.stringLiteral"),
    numericLiteral: t("editor.completion.numericLiteral"),
    booleanValue: t("editor.completion.booleanValue"),
    starExpansionColumns: t("editor.completion.starExpansionColumns"),
    tableAlias: t("editor.completion.tableAlias"),
    functionDescriptions: Object.fromEntries(SQL_FUNCTION_NAMES.map((name) => [name, t(`editor.completion.functionDescriptions.${name}`)])) as Record<string, string>,
  }));

  let deferredCompletionTriggerTimer: ReturnType<typeof setTimeout> | null = null;

  let completionEpoch = 0;

  let tableCompletionRefreshActive = false;

  let latestTableCompletionRefresh: (() => Promise<void>) | null = null;

  function queueTableCompletionRefresh(task: () => Promise<void>): void {
    latestTableCompletionRefresh = task;
    if (tableCompletionRefreshActive) return;
    tableCompletionRefreshActive = true;
    void (async () => {
      while (latestTableCompletionRefresh) {
        const next = latestTableCompletionRefresh;
        latestTableCompletionRefresh = null;
        await next();
      }
    })().finally(() => {
      tableCompletionRefreshActive = false;
    });
  }

  let completionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  let typedCompletionActivationUntil = 0;

  let suppressNextSqlCompletionAutoStartUntil = 0;

  let activeCompletionOrigin: SqlCompletionTriggerOrigin | null = null;

  function markTypedCompletionActivation() {
    typedCompletionActivationUntil = Date.now() + 500;
  }

  function isTypedCompletionActivation(explicit: boolean) {
    return explicit && typedCompletionActivationUntil >= Date.now();
  }

  function markCompletionAccepted(item: QueryCompletionItem | BatchColumnSelectionActionItem) {
    clearBatchColumnSelectionSession();
    const shouldContinueCompletion = shouldChainSqlCompletionAfterAccept(item) || (props.databaseType === "sqlserver" && item.type === "keyword" && item.label.toUpperCase() === "USE");
    suppressNextSqlCompletionAutoStartUntil = shouldContinueCompletion ? 0 : Date.now() + 750;
    completionEpoch++;
  }

  function consumeSqlCompletionAutoStartSuppression() {
    if (suppressNextSqlCompletionAutoStartUntil < Date.now()) {
      suppressNextSqlCompletionAutoStartUntil = 0;
      return false;
    }
    suppressNextSqlCompletionAutoStartUntil = 0;
    return true;
  }

  function buildCompletionResult(items: Array<QueryCompletionItem | BatchColumnSelectionActionItem>, from: number, validFor?: RegExp, prefix?: string) {
    if (items.length === 0) return null;
    const bypassFilter = !!prefix && shouldBypassCompletionFilter(prefix, items);
    const resultItems = bypassFilter && prefix ? completionItemsForBypassedFilter(prefix, items) : items;
    return {
      from,
      // Keep CodeMirror's live filtering enabled so an already-open menu follows the typed prefix.
      options: resultItems.map((item) => completionOptionForItem(item)),
      validFor,
      // When bypassing CodeMirror's matcher, supply our own highlight ranges so
      // the matched characters (Han substring or pinyin initials) stay marked.
      // Ranges must target the rendered text, which is displayLabel when set.
      ...(bypassFilter && prefix ? { filter: false as const, getMatch: (option: { label: string; displayLabel?: string }) => completionMatchRanges(option.displayLabel ?? option.label, prefix) } : {}),
    };
  }

  function buildSqlCompletionResult(items: SqlCompletionItem[], completionContext: SqlCompletionContext, fullDoc: string, position: number) {
    const replacement = prepareSqlCompletionReplacement(fullDoc, position, completionContext, items);
    const session = prepareBatchColumnSelectionSession(replacement.items, fullDoc, replacement.from, position);
    const actions: BatchColumnSelectionActionItem[] = session
      ? [
          {
            label: batchColumnSelectionAllSelected(session) ? t("editor.completion.deselectAllColumns") : t("editor.completion.selectAllColumns"),
            filterText: completionContext.prefix,
            type: "text",
            detail: t("editor.completion.selectAllColumnsDetail"),
            // Keep ordinary single-field completion as the default Enter target.
            boost: -1000,
            batchColumnSelectionAction: true,
            batchColumnSelectionToggleAll: true,
            sessionKey: session.key,
          },
          {
            label: t("editor.completion.insertSelectedColumns", { count: session.selectedKeys.size }),
            filterText: completionContext.prefix,
            type: "text",
            detail: t("editor.completion.insertSelectedColumnsDetail"),
            // Keep ordinary single-field completion as the default Enter target.
            boost: -1000,
            batchColumnSelectionAction: true,
            sessionKey: session.key,
          },
        ]
      : [];
    return buildCompletionResult(actions.length > 0 ? [...replacement.items, ...actions] : replacement.items, replacement.from, getSqlCompletionResultValidFor(fullDoc, position), completionContext.prefix);
  }

  // CodeMirror's built-in matcher only matches single-character queries against
  // the label start, and cannot match pinyin initials against Han labels. Our
  // provider already filters and ranks items itself (substring + pinyin), so
  // skip the second-stage filter exactly in the cases it would break.
  function shouldBypassCompletionFilter(prefix: string, items: Array<QueryCompletionItem | BatchColumnSelectionActionItem>): boolean {
    if (!prefix) return false;
    if (/\p{Script=Han}/u.test(prefix)) return true;
    return /^[a-z0-9]+$/i.test(prefix) && items.some((item) => /\p{Script=Han}/u.test(item.label));
  }

  function completionItemsForBypassedFilter(prefix: string, items: Array<QueryCompletionItem | BatchColumnSelectionActionItem>): Array<QueryCompletionItem | BatchColumnSelectionActionItem> {
    if ([...prefix].length !== 1 || !/^[a-z0-9]$/i.test(prefix)) return items;
    const normalized = prefix.toLowerCase();
    return items.filter((item) => {
      // The confirmation row must remain available while typing a Han/pinyin
      // prefix, otherwise checked columns cannot be applied from that menu.
      if (isBatchColumnSelectionAction(item)) return true;
      const renderedLabel = "displayLabel" in item && typeof item.displayLabel === "string" ? item.displayLabel : item.label;
      return /\p{Script=Han}/u.test(item.label) || renderedLabel.toLowerCase().startsWith(normalized);
    });
  }

  function localCompletionDatabaseNames(completionContext: ReturnType<typeof getSqlCompletionContext>): string[] {
    if (!supportsDatabaseNameCompletion(props.databaseType) || !completionContext.suggestTables || completionContext.insertTable || !props.connectionId) return [];
    return connectionStore.lookupLocalCompletionDatabases(props.connectionId, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES);
  }

  function mayCompleteDatabaseSchemaQualifier(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
    if (!supportsDatabaseNameCompletion(props.databaseType) || !supportsDatabaseSchemaQualifierCompletion() || !completionContext.suggestTables || completionContext.insertTable) return false;
    return (completionContext.qualifierParts?.filter(Boolean).length ?? completionContext.qualifier?.split(".").filter(Boolean).length ?? 0) === 1;
  }

  function localCompletionSchemasForDatabaseDisambiguation(completionContext: ReturnType<typeof getSqlCompletionContext>, databaseNames: string[], scope?: CompletionMetadataScope): string[] {
    const currentDatabase = scope?.database ?? props.database;
    const currentSchema = scope?.schema ?? props.schema;
    if (!props.connectionId || currentDatabase == null || !mayCompleteDatabaseSchemaQualifier(completionContext)) return [];
    const database = resolveSqlCompletionSchemaLookupDatabase({
      supportsDatabaseSchemaQualifier: true,
      completionContext,
      knownDatabases: databaseNames,
    });
    if (!database) return [];
    return mergeSqlCompletionQualifierNames(currentSchema ? [currentSchema] : [], connectionStore.lookupLocalCompletionSchemas(props.connectionId, currentDatabase, completionContext.qualifier, MAX_COMPLETION_TABLES));
  }

  function shouldInsertSqlCompletionSpace(): boolean {
    return props.databaseType !== "mongodb" && props.databaseType !== "redis" && props.databaseType !== "elasticsearch" && props.databaseType !== "easysearch" && props.databaseType !== "meilisearch" && props.databaseType !== "solr" && props.databaseType !== "victoriametrics";
  }

  // Snippet expansion normally follows from the item type; a provider can also
  // opt a differently-typed item in so its `${}` fields still expand on accept.
  function shouldApplyCompletionAsSnippet(item: QueryCompletionItem): boolean {
    if ("applyAsSnippet" in item && item.applyAsSnippet === true) return true;
    return item.type === "snippet" || item.type === "function";
  }

  function completionOptionForItem(item: QueryCompletionItem | BatchColumnSelectionActionItem) {
    const filterText = "filterText" in item && typeof item.filterText === "string" ? item.filterText : undefined;
    const labelPresentation = completionLabelPresentation(item.label, filterText);
    const sortText = "sortText" in item && typeof item.sortText === "string" ? item.sortText : labelPresentation.sortText;
    if (isBatchColumnSelectionAction(item)) {
      return {
        ...labelPresentation,
        ...(sortText ? { sortText } : {}),
        dbxBatchColumnSelectionAction: { sessionKey: item.sessionKey, ...(item.batchColumnSelectionToggleAll ? { toggleAll: true as const } : {}) },
        type: item.type,
        detail: item.detail,
        boost: item.boost,
        apply(view: EditorViewType, _completionItem: unknown, from: number, to: number) {
          if (item.batchColumnSelectionToggleAll) {
            // Toggling the selection never edits the document; the checkout rows
            // (and the insert action) are refreshed in place instead.
            toggleAllBatchColumnSelection(view, item.sessionKey);
            return;
          }
          applyBatchColumnSelection(view, item, from, to);
        },
      };
    }
    const record = () => {
      recordCompletionSelection(item.label, item.type);
    };
    const batchColumnSelection = batchColumnSelectionMarkerForItem(item);
    if (shouldApplyCompletionAsSnippet(item) && item.apply) {
      const completion = runtime.codeMirrorSnippetCompletion(item.apply, {
        ...labelPresentation,
        ...(sortText ? { sortText } : {}),
        type: item.type,
        detail: item.detail,
        info: item.info,
        boost: item.boost,
      });
      const originalApply = completion.apply;
      return cacheBatchColumnSelectionOption(batchColumnSelection, {
        ...completion,
        ...(batchColumnSelection ? { dbxBatchColumnSelection: batchColumnSelection } : {}),
        apply(view: EditorViewType, completionItem: unknown, from: number, to: number) {
          record();
          markCompletionAccepted(item);
          const nextCharacter = view.state.sliceDoc(to, to + 1);
          const replaceTo = completionReplacementTo({
            from,
            to,
            nextCharacter,
            replaceClosingQuote: "replaceClosingQuote" in item ? item.replaceClosingQuote : undefined,
            replaceSelectWildcard: "replaceSelectWildcard" in item ? item.replaceSelectWildcard : undefined,
          });
          if (typeof originalApply === "function") {
            originalApply(view, completionItem as never, from, replaceTo);
          } else {
            const insert = String(originalApply ?? item.label);
            view.dispatch({
              changes: { from, to: replaceTo, insert },
              selection: { anchor: from + insert.length },
            });
          }
          if (props.databaseType === "mongodb") {
            const position = view.state.selection.main.head;
            if (getMongoCompletionContext(view.state.doc.toString(), position).mode === "collectionRef") {
              scheduleSqlCompletionStart(view, 50);
            }
          }
        },
      });
    }
    return cacheBatchColumnSelectionOption(batchColumnSelection, {
      ...labelPresentation,
      ...(sortText ? { sortText } : {}),
      ...(batchColumnSelection ? { dbxBatchColumnSelection: batchColumnSelection } : {}),
      type: item.type,
      detail: item.detail,
      info: item.info,
      boost: item.boost,
      apply(view: EditorViewType, _completionItem: unknown, from: number, to: number) {
        record();
        markCompletionAccepted(item);
        const nextCharacterAtCursor = view.state.sliceDoc(to, to + 1);
        const replaceTo = completionReplacementTo({
          from,
          to,
          nextCharacter: nextCharacterAtCursor,
          replaceClosingQuote: "replaceClosingQuote" in item ? item.replaceClosingQuote : undefined,
          replaceSelectWildcard: "replaceSelectWildcard" in item ? item.replaceSelectWildcard : undefined,
        });
        const insert = appendSqlCompletionSpace(item.apply ?? item.label, {
          enabled: ("appendSpace" in item && item.appendSpace === true) || (shouldInsertSqlCompletionSpace() && settingsStore.editorSettings.insertSpaceAfterCompletion),
          itemType: item.type,
          nextCharacter: view.state.sliceDoc(replaceTo, replaceTo + 1),
        });
        if (runtime.codeMirrorInsertCompletionText) {
          view.dispatch(runtime.codeMirrorInsertCompletionText(view.state, insert, from, replaceTo));
        } else {
          view.dispatch({
            changes: { from, to: replaceTo, insert },
            selection: { anchor: from + insert.length },
          });
        }
      },
    });
  }

  async function provideElasticsearchCompletions(currentState: import("@codemirror/state").EditorState, position: number, explicit: boolean) {
    if (!props.connectionId) return null;
    const epoch = ++completionEpoch;
    const fullDoc = currentState.doc.toString();
    if (!explicit && !shouldAutoOpenElasticsearchCompletion(fullDoc, position)) return null;

    const completionContext = getElasticsearchCompletionContext(fullDoc, position);
    let indices: string[] = [];
    let fields: ElasticsearchCompletionField[] = [];
    if (props.database != null && completionContext.mode === "path") {
      try {
        indices = await connectionStore.listElasticsearchCompletionIndices(props.connectionId, props.database);
      } catch {
        indices = [];
      }
    }
    if (elasticsearchCompletionNeedsFields(completionContext) && completionContext.index) {
      try {
        fields = await connectionStore.listElasticsearchCompletionFields(props.connectionId, completionContext.index);
      } catch {
        fields = [];
      }
    }
    if (epoch !== completionEpoch) return null;

    const items = buildElasticsearchCompletionItemsFromContext(completionContext, { indices, fields });
    return buildCompletionResult(items, completionContext.from, getElasticsearchCompletionResultValidFor());
  }

  async function provideRedisCompletions(currentState: import("@codemirror/state").EditorState, position: number, explicit: boolean) {
    if (!props.connectionId) return null;
    const epoch = ++completionEpoch;
    const fullDoc = currentState.doc.toString();
    if (!explicit && !shouldAutoOpenRedisCompletion(fullDoc, position)) return null;

    let commands;
    try {
      commands = await connectionStore.listRedisCompletionCommandDocs(props.connectionId, props.database ?? "0");
    } catch {
      // Completion is deliberately instance-driven: do not substitute a bundled
      // command list when the server does not expose command metadata.
      return null;
    }
    if (epoch !== completionEpoch) return null;

    const completionInput = { commands };
    const completionContext = getRedisCompletionContext(fullDoc, position, completionInput);
    // Key-name completion needs a reliable db index; props.database may briefly be "" on
    // the New Query path before the active db resolves, and only key-argument commands warrant it.
    let keys: string[] = [];
    if (completionContext.mode === "argument" && props.database && takesKeyArgument(completionContext.commandName, completionInput, completionContext.argumentIndex, completionContext.argumentValues)) {
      try {
        keys = await connectionStore.listRedisCompletionKeys(props.connectionId, props.database);
      } catch {
        keys = [];
      }
    }
    if (epoch !== completionEpoch) return null;

    const items = buildRedisCompletionItemsFromContext(completionContext, {
      keys,
      commands,
    });
    if (items.length === 0) return null;
    // Use the built-in filter (the default) so typing narrows the list and moves
    // the selection synchronously. `filter: false` + `validFor` are mutually
    // exclusive (the latter is ignored), which would leave the menu frozen while
    // typing — hence we build the result here instead of via buildCompletionResult.
    return {
      from: completionContext.from,
      options: items.map((item) => completionOptionForItem(item)),
      validFor: getRedisCompletionResultValidFor(),
    };
  }

  async function provideMongoCompletions(currentState: import("@codemirror/state").EditorState, position: number, explicit: boolean) {
    if (!props.connectionId) return null;
    const epoch = ++completionEpoch;
    const fullDoc = currentState.doc.toString();
    if (!explicit && !shouldAutoOpenMongoCompletion(fullDoc, position)) return null;

    const completionContext = getMongoCompletionContext(fullDoc, position);
    let collections: string[] = [];
    let fields: Awaited<ReturnType<typeof connectionStore.listMongoCompletionFields>> = [];

    if (props.database && mongoCompletionNeedsCollections(completionContext.mode)) {
      try {
        collections = await connectionStore.listMongoCompletionCollections(props.connectionId, props.database);
      } catch {
        collections = [];
      }
    }

    if (props.database && mongoCompletionNeedsFields(completionContext.mode) && completionContext.collection) {
      try {
        fields = await connectionStore.listMongoCompletionFields(props.connectionId, props.database, completionContext.collection);
      } catch {
        fields = [];
      }
    }

    if (epoch !== completionEpoch) return null;

    const items = buildMongoCompletionItemsFromContext(completionContext, {
      collections,
      fields,
    });
    if (items.length === 0) return null;
    return {
      from: completionContext.from,
      options: items.map((item) => completionOptionForItem(item)),
      validFor: getMongoCompletionResultValidFor(completionContext),
    };
  }

  async function provideSqlCompletions(context: CompletionContext) {
    const currentState = context.state;
    const position = context.pos;
    const explicit = context.explicit;
    const typedActivation = isTypedCompletionActivation(explicit);
    if (runtime.imeCompositionActive || view.value?.compositionStarted || view.value?.composing) return null;
    if (!props.connectionId) return null;
    const fullDoc = currentState.doc.toString();
    if (props.databaseType === "mongodb") {
      return provideMongoCompletions(currentState, position, explicit);
    }
    if (props.databaseType === "meilisearch" || props.databaseType === "solr") return null;
    if (props.databaseType === "elasticsearch" || props.databaseType === "easysearch") {
      if (!isSqlLikeCompletionStatement(fullDoc, position, sqlCompletionDialectOptions())) {
        return provideElasticsearchCompletions(currentState, position, explicit);
      }
    }
    if (props.databaseType === "redis") {
      return provideRedisCompletions(currentState, position, explicit);
    }
    if (props.databaseType === "victoriametrics") return null;
    const hasDatabase = props.database != null;
    const sequenceLiteralContext = getPostgresSequenceLiteralCompletionContext(fullDoc, position, props.databaseType);
    const databaseLinkContext = oracleDatabaseLinkCompletionContext(fullDoc, position, props.databaseType);

    const epoch = ++completionEpoch;

    try {
      // 1. Suppressed context (comment / string literal) rejects everything, including explicit.
      if (isSqlCompletionSuppressedContext(fullDoc, position, { databaseType: props.databaseType, editorState: currentState }) && !sequenceLiteralContext) return null;

      // 2. Determine completion origin (session-level marker).
      activeCompletionOrigin = originForSqlCompletionProvider(activeCompletionOrigin, context.explicit);
      const origin = activeCompletionOrigin;

      // 3. Explicit (manual shortcut) -> always proceed. No mode gating.
      // 4. For typing sessions, apply mode gating with lazy fact computation.
      const useDatabaseCompletion = resolveSqlServerUseDatabaseCompletion({
        sql: fullDoc,
        cursor: position,
        databaseType: props.databaseType,
      });
      const useDatabasePrefix = useDatabaseCompletion?.prefix ?? null;

      if (origin !== "explicit") {
        const mode = settingsStore.editorSettings.completionTriggerMode;

        // manual: never auto-open. Return before computing any context.
        if (mode === "manual") return null;

        // require-prefix: only compute local facts (no positionalEligible).
        if (mode === "require-prefix") {
          const ctx = databaseLinkContext ?? sequenceLiteralContext ?? getEditorSqlCompletionContext(fullDoc, position);
          const prevChar = fullDoc[position - 1] ?? "";
          const facts: SqlCompletionTriggerFacts = {
            origin,
            hasIdentifierPrefix: ctx.prefix.length > 0,
            qualifierTriggered: !!databaseLinkContext || (prevChar === "." && ("schema" in ctx ? ctx.schema != null : "qualifier" in ctx && ctx.qualifier != null)),
            useDatabasePrefix,
          };
          if (!shouldAllowSqlCompletionTrigger(mode, facts)) return null;
        }

        // positional: compute positionalEligible (lazy).
        if (mode === "positional") {
          const ctx = databaseLinkContext ?? sequenceLiteralContext ?? getEditorSqlCompletionContext(fullDoc, position);
          const prevChar = fullDoc[position - 1] ?? "";
          const positionalEligible = shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
          const facts: SqlCompletionTriggerFacts = {
            origin,
            hasIdentifierPrefix: ctx.prefix.length > 0,
            qualifierTriggered: !!databaseLinkContext || (prevChar === "." && ("schema" in ctx ? ctx.schema != null : "qualifier" in ctx && ctx.qualifier != null)),
            useDatabasePrefix,
            positionalEligible,
          };
          if (!shouldAllowSqlCompletionTrigger(mode, facts)) return null;
        }
      }

      if (useDatabaseCompletion) {
        const currentDatabase = props.database ?? "";
        if (!currentDatabase) return null;
        let sqlServerContext: SqlServerCompletionContext;
        try {
          sqlServerContext = await connectionStore.getSqlServerCompletionContext(props.connectionId, currentDatabase);
        } catch {
          // Without a server-reported capability, do not suggest a USE target
          // that the current SQL Server session may be unable to switch to.
          return null;
        }
        if (sqlServerContext.supports_session_database_switch) {
          try {
            await connectionStore.listCompletionDatabases(props.connectionId);
          } catch {
            // Keep locally indexed database names available when metadata refresh fails.
          }
        }
        if (epoch !== completionEpoch) return null;
        const databaseNames = sqlServerUseCompletionDatabaseNames({
          databaseNames: connectionStore.lookupLocalCompletionDatabases(props.connectionId, useDatabaseCompletion.prefix, MAX_COMPLETION_TABLES),
          currentDatabase,
          supportsSessionDatabaseSwitch: sqlServerContext.supports_session_database_switch,
        });
        const items = buildSqlServerUseDatabaseCompletionItems(databaseNames, useDatabaseCompletion);
        return buildCompletionResult(items, useDatabaseCompletion.from, undefined, useDatabaseCompletion.prefix);
      }

      if (databaseLinkContext) {
        if (!hasDatabase) return null;
        const links = await connectionStore.listOracleDatabaseLinks(props.connectionId, props.database!);
        if (epoch !== completionEpoch) return null;
        return {
          from: databaseLinkContext.from,
          to: databaseLinkContext.to,
          options: oracleDatabaseLinkCompletionItems(links, databaseLinkContext.prefix).map((item) => ({
            ...item,
            apply(editor: EditorViewType, _completion: unknown, from: number, to: number) {
              markCompletionAccepted({ label: item.label, type: "text", boost: 0 });
              // Keep the entire link suffix intact and use the normal completion
              // transaction so accepting a link does not immediately reopen the menu.
              if (runtime.codeMirrorInsertCompletionText) editor.dispatch(runtime.codeMirrorInsertCompletionText(editor.state, item.apply, from, to));
              else editor.dispatch({ changes: { from, to, insert: item.apply }, selection: { anchor: from + item.apply.length } });
            },
          })),
          validFor: /^[A-Za-z0-9_$#.]*$/,
        };
      }

      if (sequenceLiteralContext) {
        if (!hasDatabase) return null;
        const sequences = await connectionStore.listCompletionObjects(props.connectionId, props.database!, sequenceLiteralContext.prefix, MAX_COMPLETION_TABLES, sequenceLiteralContext.schema, undefined, false, undefined, ["sequence"], sequenceLiteralContext.nameQuoted);
        if (epoch !== completionEpoch) return null;
        return buildCompletionResult(buildPostgresSequenceLiteralCompletionItems(sequenceLiteralContext, sequences), sequenceLiteralContext.from, undefined, sequenceLiteralContext.prefix);
      }

      const legacyCompletionContext = getEditorSqlCompletionContext(fullDoc, position);
      const semanticModel = SEMANTIC_SQL_COMPLETION_ENABLED ? buildSqlSemanticModel(fullDoc, position, sqlCompletionDialectOptions()) : null;
      let completionContext = semanticModel ? sqlCompletionContextFromSemantic(semanticModel, legacyCompletionContext) : legacyCompletionContext;

      if (!hasDatabase) {
        const items = buildSqlCompletionItemsFromContext(completionContext, {
          tables: [],
          objects: [],
          columnsByTable: new Map(),
          schemas: [],
          translations: completionTranslations.value,
          snippets: settingsStore.editorSettings.snippets,
          dialect: props.dialect,
          databaseType: snippetDatabaseType.value,
          driverProfile: sqlDriverProfile.value,
          currentSchema: props.schema,
          keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
          functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
          autoAliasTables: settingsStore.editorSettings.autoAliasTables,
          quoteIdentifiers: settingsStore.editorSettings.generateSqlQuoteIdentifiers,
        });
        return buildSqlCompletionResult(items, completionContext, fullDoc, position);
      }

      const useDatabase = props.databaseType === "sqlserver" ? sqlServerUseDatabaseBeforeCursor(fullDoc, position) : undefined;
      let knownUseDatabases: string[] | undefined;
      let supportsSessionDatabaseSwitch: boolean | undefined;
      let useDatabaseDefaultSchema: string | undefined;
      if (useDatabase) {
        try {
          const currentContext = await connectionStore.getSqlServerCompletionContext(props.connectionId, props.database!);
          supportsSessionDatabaseSwitch = currentContext.supports_session_database_switch;
          knownUseDatabases = [props.database!];
          if (supportsSessionDatabaseSwitch) {
            knownUseDatabases = mergeSqlCompletionQualifierNames(knownUseDatabases, connectionStore.lookupLocalCompletionDatabases(props.connectionId, "", MAX_COMPLETION_TABLES));
            if (!knownUseDatabases.some((database) => database.toLowerCase() === useDatabase.toLowerCase())) {
              knownUseDatabases = mergeSqlCompletionQualifierNames(knownUseDatabases, await connectionStore.listCompletionDatabases(props.connectionId));
            }
          }
          const targetDatabase = knownUseDatabases.find((database) => database.toLowerCase() === useDatabase.toLowerCase());
          if (targetDatabase) {
            const targetContext = targetDatabase.toLowerCase() === props.database!.toLowerCase() ? currentContext : await connectionStore.getSqlServerCompletionContext(props.connectionId, targetDatabase);
            useDatabaseDefaultSchema = targetContext.default_schema;
          }
        } catch {
          // An unverified USE target must not replace the selected database.
        }
        if (epoch !== completionEpoch) return null;
      }

      const completionScope = resolveSqlCompletionScope({
        sql: fullDoc,
        cursor: position,
        databaseType: props.databaseType,
        currentDatabase: props.database!,
        currentSchema: props.schema,
        knownDatabases: knownUseDatabases,
        supportsSessionDatabaseSwitch,
        useDatabaseDefaultSchema,
        completionContext,
      });
      completionContext = completionScope.completionContext;

      const needsAsyncData =
        completionContext.suggestTables || completionContext.suggestRoutines || completionContext.exclusiveRoutineSuggestions || !!completionContext.qualifier || !!completionContext.insertTable || completionContext.exclusiveColumnSuggestions || completionContext.referencedTables.length > 0;

      if (!needsAsyncData) {
        const items = buildSqlCompletionItemsFromContext(completionContext, {
          tables: [],
          objects: [],
          columnsByTable: new Map(),
          schemas: [],
          translations: completionTranslations.value,
          snippets: settingsStore.editorSettings.snippets,
          dialect: props.dialect,
          databaseType: snippetDatabaseType.value,
          driverProfile: sqlDriverProfile.value,
          currentSchema: props.schema,
          keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
          functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
          autoAliasTables: settingsStore.editorSettings.autoAliasTables,
          quoteIdentifiers: settingsStore.editorSettings.generateSqlQuoteIdentifiers,
        });
        return buildSqlCompletionResult(items, completionContext, fullDoc, position);
      }

      const tableNameCompletion = isTableNameCompletionContext(completionContext);
      const shouldResolveColumnCompletion = shouldResolveSqlColumnCompletion({
        suggestColumns: completionContext.suggestColumns,
        hasReferencedTables: completionContext.referencedTables.length > 0,
        prefix: completionContext.prefix,
        typedActivation,
        selectListColumnContext: completionContext.selectListColumnContext,
      });
      const shouldResolveAsyncCompletion = tableNameCompletion || shouldResolveColumnCompletion;
      const localResult = buildLocalSqlCompletionResult(completionContext, fullDoc, position, completionScope);
      if (localResult) {
        scheduleCompletionMetadataRefresh(completionContext, fullDoc, position, completionScope);
        const hasLocalColumnResult = localResult.options.some((option) => option.type === "column");
        if ((!explicit || typedActivation) && (!shouldResolveColumnCompletion || hasLocalColumnResult)) return localResult;
      }
      if ((!explicit || typedActivation) && !shouldResolveAsyncCompletion) {
        scheduleCompletionMetadataRefresh(completionContext, fullDoc, position, completionScope);
        return null;
      }

      // Cancel any pending debounced completion
      if (completionDebounceTimer) {
        clearTimeout(completionDebounceTimer);
        completionDebounceTimer = null;
      }

      // Debounce the full async flow and return the promise to CodeMirror.
      // This prevents wasted backend calls during rapid typing while still
      // showing table/column names in the first popup.
      return new Promise<ReturnType<typeof buildCompletionResult>>((resolve) => {
        context.addEventListener("abort", () => {
          if (epoch === completionEpoch) completionEpoch++;
        });
        completionDebounceTimer = setTimeout(async () => {
          completionDebounceTimer = null;
          if (epoch !== completionEpoch) {
            resolve(null);
            return;
          }
          try {
            const result = await performAsyncCompletionWithResult(epoch, completionContext, fullDoc, position, completionScope);
            resolve(result ?? localResult);
          } catch {
            resolve(localResult);
          }
        }, COMPLETION_DEBOUNCE_DELAY_MS);
      });
    } catch {
      return null;
    }
  }

  // Manual-trigger shortcut (default Alt+/). Opens the completion popup on the
  // explicit path so auto-trigger mode gating is bypassed. Unlike
  // scheduleSqlCompletionStart, it must NOT mark the activation as typed, or the
  // session would be misclassified as typing and gated for 500ms.
  function triggerSqlCompletion(currentView: EditorViewType): boolean {
    if (!runtime.codeMirrorStartCompletion || isEditorComposing(currentView)) return false;
    return runtime.codeMirrorStartCompletion(currentView);
  }

  function scheduleSqlCompletionStart(currentView: EditorViewType, delayMs = 0) {
    window.setTimeout(() => {
      if (!runtime.codeMirrorStartCompletion || isEditorComposing(currentView)) return;
      markTypedCompletionActivation();
      activeCompletionOrigin = originForTypedSqlCompletionStart(activeCompletionOrigin);
      runtime.codeMirrorStartCompletion(currentView);
    }, delayMs);
  }

  function clearDeferredCompletionTrigger() {
    if (deferredCompletionTriggerTimer === null) return;
    clearTimeout(deferredCompletionTriggerTimer);
    deferredCompletionTriggerTimer = null;
  }

  function scheduleDeferredCompletionTrigger(currentView: EditorViewType, insertedText: string, removedText: string) {
    clearDeferredCompletionTrigger();
    const expectedDoc = currentView.state.doc;
    const expectedPosition = currentView.state.selection.main.head;
    deferredCompletionTriggerTimer = setTimeout(() => {
      deferredCompletionTriggerTimer = null;
      if (view.value !== currentView || currentView.state.doc !== expectedDoc || currentView.state.selection.main.head !== expectedPosition || isEditorComposing(currentView)) return;
      if (shouldStartSqlCompletionAfterInput(insertedText, removedText, currentView)) {
        scheduleSqlCompletionStart(currentView);
      }
    }, COMPLETION_TRIGGER_DEFER_DELAY_MS);
  }

  /**
   * Returns true when the current SQL position should trigger completion under the active trigger mode.
   * Used by flushImeComposition and shouldStartSqlCompletionAfterInput.
   */
  function shouldTriggerSqlCompletionForPosition(fullDoc: string, position: number): boolean {
    const sequenceLiteralContext = getPostgresSequenceLiteralCompletionContext(fullDoc, position, props.databaseType);
    const databaseLinkContext = oracleDatabaseLinkCompletionContext(fullDoc, position, props.databaseType);
    if (isSqlCompletionSuppressedContext(fullDoc, position, { databaseType: props.databaseType, editorState: view.value?.state }) && !sequenceLiteralContext) return false;
    const mode = settingsStore.editorSettings.completionTriggerMode;
    if (mode === "manual") return false;

    const useDatabaseCompletion = resolveSqlServerUseDatabaseCompletion({
      sql: fullDoc,
      cursor: position,
      databaseType: props.databaseType,
    });
    const useDatabasePrefix = useDatabaseCompletion?.prefix ?? null;

    if (mode === "require-prefix") {
      const ctx = databaseLinkContext ?? sequenceLiteralContext ?? getEditorSqlCompletionContext(fullDoc, position);
      const prevChar = fullDoc[position - 1] ?? "";
      const facts: SqlCompletionTriggerFacts = {
        origin: "typing",
        hasIdentifierPrefix: ctx.prefix.length > 0,
        qualifierTriggered: !!databaseLinkContext || (prevChar === "." && ("schema" in ctx ? ctx.schema != null : "qualifier" in ctx && ctx.qualifier != null)),
        useDatabasePrefix,
      };
      return shouldAllowSqlCompletionTrigger(mode, facts);
    }

    // positional
    const ctx = databaseLinkContext ?? sequenceLiteralContext ?? getEditorSqlCompletionContext(fullDoc, position);
    const prevChar = fullDoc[position - 1] ?? "";
    const positionalEligible = shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
    const facts: SqlCompletionTriggerFacts = {
      origin: "typing",
      hasIdentifierPrefix: ctx.prefix.length > 0,
      qualifierTriggered: !!databaseLinkContext || (prevChar === "." && ("schema" in ctx ? ctx.schema != null : "qualifier" in ctx && ctx.qualifier != null)),
      useDatabasePrefix,
      positionalEligible,
    };
    return shouldAllowSqlCompletionTrigger(mode, facts);
  }

  function shouldStartSqlCompletionAfterInput(insertedText: string, removedText: string, currentView: EditorViewType): boolean {
    const position = currentView.state.selection.main.head;
    const fullDoc = currentView.state.doc.toString();

    // Non-SQL providers: keep existing behavior (trigger mode policy does not apply).
    if (props.databaseType === "mongodb") {
      return !!(insertedText || removedText) && shouldAutoOpenMongoCompletion(fullDoc, position);
    }
    if (props.databaseType === "victoriametrics" || props.databaseType === "meilisearch" || props.databaseType === "solr") return false;
    if (props.databaseType === "redis" || props.databaseType === "elasticsearch" || props.databaseType === "easysearch") {
      // Preserve old character-based checks for non-SQL providers.
      if (!insertedText && removedText) {
        const completionContext = getEditorSqlCompletionContext(fullDoc, position);
        return isTableNameCompletionContext(completionContext) && shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
      }
      if (insertedText.endsWith(".")) return true;
      if (/[,(]$/.test(insertedText)) {
        const completionContext = getEditorSqlCompletionContext(fullDoc, position);
        return !!completionContext.insertTable;
      }
      if (/\s$/.test(insertedText)) {
        return shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
      }
      if (!/[\w$@]$/.test(insertedText)) return false;
      const completionContext = getEditorSqlCompletionContext(fullDoc, position);
      return isTableNameCompletionContext(completionContext) || shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
    }

    // SQL providers: use unified trigger mode policy.
    return shouldTriggerSqlCompletionForPosition(fullDoc, position);
  }

  function buildLocalSqlCompletionResult(completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number, scope: CompletionMetadataScope) {
    if (!props.connectionId || props.database == null) return null;
    const databaseNames = localCompletionDatabaseNames(completionContext);
    const currentDatabaseSchemaNames = localCompletionSchemasForDatabaseDisambiguation(completionContext, databaseNames, scope);
    const schemaLookupDatabase = resolveSqlCompletionSchemaLookupDatabase({
      supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
      completionContext,
      knownDatabases: databaseNames,
      knownSchemas: currentDatabaseSchemaNames,
    });
    const shouldLoadTables = !schemaLookupDatabase && (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext)));
    const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
      currentDatabase: scope.database,
      currentSchema: scope.schema,
      supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
      supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
      completionContext,
      knownDatabases: databaseNames,
    });
    const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
    const tables = schemaLookupDatabase
      ? []
      : shouldLoadTables
        ? connectionStore.lookupLocalCompletionTables(props.connectionId, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, globalOracleTableSearch ? undefined : tableLookupTarget.schema, props.catalog)
        : completionMetadata.cachedTables;

    const shouldLoadObjects = shouldLoadCompletionObjects(completionContext);
    const completionObjectScope = routineCompletionScopeForContext(completionContext, scope);
    const scopedCachedCompletionObjects = completionObjectsForScope(completionObjectScope);
    const completionObjects = shouldLoadObjects ? lookupLocalCompletionObjectsForContext(completionContext, scope) : scopedCachedCompletionObjects;

    const schemaNames =
      completionContext.suggestTables && !completionContext.insertTable
        ? schemaLookupDatabase
          ? connectionStore.lookupLocalCompletionSchemas(props.connectionId, schemaLookupDatabase, completionContext.prefix, MAX_COMPLETION_TABLES)
          : !completionContext.qualifier
            ? mergeSqlCompletionQualifierNames(connectionStore.lookupLocalCompletionSchemas(props.connectionId, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES), databaseNames)
            : []
        : [];

    const columnsByTable = new Map<string, SqlCompletionColumn[]>();
    if (completionContext.insertTable) {
      const insertDatabase = (supportsDatabaseSchemaQualifierCompletion() ? completionContext.insertDatabase : undefined) ?? scope.database;
      const insertSchema = completionContext.insertSchema ?? scope.schema;
      const insertColumns = usesOracleSessionCompletionColumns(insertSchema) ? [] : connectionStore.lookupLocalCompletionColumns(props.connectionId, insertDatabase, completionContext.insertTable, insertSchema, props.catalog);
      if (insertColumns.length > 0) {
        columnsByTable.set(completionCacheKey({ name: completionContext.insertTable, database: completionContext.insertDatabase, schema: insertSchema }, scope), insertColumns);
      }
    }

    const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
    if (qualifiedColumnTarget) {
      const reference = completionContext.referencedTables.find((table) => completionTablesMatch(table, qualifiedColumnTarget));
      const qualifiedCacheTable = { ...qualifiedColumnTarget, nameQuoted: reference?.nameQuoted, schemaQuoted: reference?.schemaQuoted };
      const cacheKey = completionCacheKey(qualifiedCacheTable, scope);
      const cachedPrefix = completionContext.prefix.length >= 2 && (props.databaseType === "postgres" || props.databaseType === "mysql") ? lookupCachedPrefixColumns(qualifiedCacheTable, scope, completionContext.prefix) : undefined;
      const cached = cachedPrefix ?? cachedColumnsByTable.get(cacheKey);
      if (cached) {
        columnsByTable.set(cacheKey, cached);
      } else {
        const target = completionMetadataTarget(qualifiedColumnTarget, scope);
        const prefixColumns =
          target && completionContext.prefix.length >= 2 && (props.databaseType === "postgres" || props.databaseType === "mysql")
            ? connectionStore.lookupLocalCompletionColumnsByPrefix(props.connectionId, target.database, qualifiedColumnTarget.name, target.schema, completionContext.prefix, target.catalog, completionColumnRequestContext(reference))
            : [];
        const localColumns =
          prefixColumns.length > 0
            ? prefixColumns
            : target && !usesOracleSessionCompletionColumns(target.schema)
              ? connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, qualifiedColumnTarget.name, target.schema, target.catalog, completionColumnRequestContext(reference))
              : [];
        if (localColumns.length > 0) {
          columnsByTable.set(cacheKey, localColumns);
        }
      }
    }

    const cteDefs = extractCteDefinitions(fullDoc);
    for (const refTable of completionContext.referencedTables) {
      if (refTable.columns?.length) {
        columnsByTable.set(
          refTable.name,
          refTable.columns.map((name) => ({ name, table: refTable.name, schema: refTable.schema })),
        );
        continue;
      }
      if (isVirtualCompletionTableReference(refTable)) continue;
      const cteDef = cteDefs.find((c) => c.name.toLowerCase() === refTable.name.toLowerCase());
      if (cteDef) {
        columnsByTable.set(
          refTable.name,
          cteDef.columns.map((name) => ({
            name,
            table: refTable.name,
            dataType: undefined,
          })),
        );
        continue;
      }
      const cacheKey = completionCacheKey(refTable, scope);
      const prefixCompletion =
        (props.databaseType === "postgres" || props.databaseType === "mysql") &&
        completionContext.qualifier &&
        completionContext.prefix.length >= 2 &&
        isReferencedTableQualifier(completionContext) &&
        (refTable.alias?.toLowerCase() === completionContext.qualifier.toLowerCase() || refTable.name.toLowerCase() === completionContext.qualifier.toLowerCase())
          ? completionContext.prefix
          : undefined;
      const cached = (prefixCompletion ? lookupCachedPrefixColumns(refTable, scope, prefixCompletion) : undefined) ?? cachedColumnsByTable.get(cacheKey);
      if (cached) {
        columnsByTable.set(cacheKey, cached);
        continue;
      }
      const target = completionMetadataTarget(refTable, scope);
      const prefixColumns = target && prefixCompletion ? connectionStore.lookupLocalCompletionColumnsByPrefix(props.connectionId, target.database, refTable.name, target.schema, prefixCompletion, target.catalog, refTable) : [];
      const localColumns = prefixColumns.length > 0 ? prefixColumns : target && !usesOracleSessionCompletionColumns(target.schema) ? connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, refTable.name, target.schema, target.catalog, refTable) : [];
      if (localColumns.length > 0) {
        columnsByTable.set(cacheKey, localColumns);
      }
      const localForeignKeys = target ? connectionStore.lookupLocalCompletionForeignKeys(props.connectionId, target.database, refTable.name, target.schema) : [];
      if (localForeignKeys.length > 0) {
        cachedForeignKeysByTable.set(cacheKey, localForeignKeys);
      }
    }

    if (
      tables.length === 0 &&
      completionObjects.length === 0 &&
      schemaNames.length === 0 &&
      columnsByTable.size === 0 &&
      !driverProfileHasCompletionCandidates(sqlDriverProfile.value, completionContext) &&
      (completionContext.exclusiveTableSuggestions || completionContext.exclusiveColumnSuggestions || completionContext.exclusiveRoutineSuggestions)
    ) {
      return null;
    }

    const items = buildSqlCompletionItemsFromContext(completionContext, {
      tables,
      objects: completionObjects,
      columnsByTable,
      foreignKeysByTable: cachedForeignKeysByTable,
      schemas: schemaNames,
      translations: completionTranslations.value,
      snippets: settingsStore.editorSettings.snippets,
      dialect: props.dialect,
      databaseType: snippetDatabaseType.value,
      driverProfile: sqlDriverProfile.value,
      currentSchema: scope.schema,
      keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
      functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
      autoAliasTables: settingsStore.editorSettings.autoAliasTables,
      quoteIdentifiers: settingsStore.editorSettings.generateSqlQuoteIdentifiers,
    });

    return buildSqlCompletionResult(items, completionContext, fullDoc, position);
  }

  function scheduleCompletionMetadataRefresh(completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number, scope: CompletionMetadataScope) {
    if (!props.connectionId || props.database == null) return;
    const localOnlyMetadata = usesLocalOnlyCompletionMetadata();
    const onDemandOnlyColumns = usesOnDemandOnlyCompletionColumns();
    const tableNameCompletion = isTableNameCompletionContext(completionContext);
    const connectionId = props.connectionId;
    const database = scope.database;
    const databaseNames = localCompletionDatabaseNames(completionContext);
    const currentDatabaseSchemaNames = localCompletionSchemasForDatabaseDisambiguation(completionContext, databaseNames, scope);
    const schemaLookupDatabase = resolveSqlCompletionSchemaLookupDatabase({
      supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
      completionContext,
      knownDatabases: databaseNames,
      knownSchemas: currentDatabaseSchemaNames,
    });
    const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
      currentDatabase: database,
      currentSchema: scope.schema,
      supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
      supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
      completionContext,
      knownDatabases: databaseNames,
    });
    if (!localOnlyMetadata && !schemaLookupDatabase && (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext)))) {
      const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
      const refreshEpoch = completionEpoch;
      queueTableCompletionRefresh(async () => {
        if (refreshEpoch !== completionEpoch) return;
        try {
          const tables = await connectionStore.refreshCompletionTables(connectionId, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, tableLookupTarget.schema, globalOracleTableSearch, scope.schema, props.catalog);
          if (refreshEpoch !== completionEpoch) return;
          const scopedTables = tables.map((table) => ({ ...table, database: table.database ?? tableLookupTarget.database }));
          completionMetadata.cachedTables = mergeCompletionTables(completionMetadata.cachedTables, scopedTables);
          if (completionContext.suggestJoinConditions && completionContext.referencedTables.length > 0) {
            void ensureForeignKeysForTables(completionContext.referencedTables);
          }
        } catch {
          // Local candidates remain available when the remote refresh fails.
        }
      });
    }
    if (!localOnlyMetadata && shouldLoadCompletionObjects(completionContext)) {
      const completionObjectScope = routineCompletionScopeForContext(completionContext, scope);
      void listCompletionObjectsForContext(completionContext, scope)
        .then((objects) => {
          const cachedObjects = completionObjectsForScope(completionObjectScope);
          const merged = mergeCompletionObjects(cachedObjects, objects);
          const changed = completionObjectsDiffer(cachedObjects, merged);
          cachedCompletionObjectsByScope.set(completionObjectScopeKey(completionObjectScope), merged);
          if (changed) refreshActiveSqlCompletion(fullDoc, position, completionContext);
        })
        .catch(() => {});
    }
    if (!localOnlyMetadata && completionContext.suggestTables && !completionContext.insertTable) {
      if (schemaLookupDatabase) {
        void connectionStore.refreshCompletionSchemas(connectionId, schemaLookupDatabase).catch(() => {});
      } else if (!completionContext.qualifier) {
        void connectionStore.refreshCompletionSchemas(connectionId, database).catch(() => {});
        if (supportsDatabaseNameCompletion(props.databaseType)) {
          void connectionStore.refreshCompletionDatabases(connectionId).catch(() => {});
        }
      }
    }
    if (!onDemandOnlyColumns && completionContext.insertTable) {
      const insertTable = completionContext.insertTable;
      const insertDatabase = (supportsDatabaseSchemaQualifierCompletion() ? completionContext.insertDatabase : undefined) ?? database;
      void refreshCompletionColumnsForEditor(connectionId, insertDatabase, insertTable, completionContext.insertSchema ?? scope.schema)
        .then((columns) => {
          const insertSchema = completionContext.insertSchema ?? scope.schema;
          cachedColumnsByTable.set(completionCacheKey({ name: insertTable, database: completionContext.insertDatabase, schema: insertSchema }, scope), columns);
        })
        .catch(() => {});
    }
    const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
    const qualifiedColumnCacheKey = qualifiedColumnTarget ? completionCacheKey(qualifiedColumnTarget, scope) : undefined;
    if (!onDemandOnlyColumns && qualifiedColumnTarget && qualifiedColumnCacheKey && !cachedColumnsByTable.has(qualifiedColumnCacheKey)) {
      const target = completionMetadataTarget(qualifiedColumnTarget, scope);
      if (target) {
        void refreshCompletionColumnsForEditor(connectionId, target.database, qualifiedColumnTarget.name, target.schema, target.catalog)
          .then((columns) => {
            if (columns.length > 0) cachedColumnsByTable.set(qualifiedColumnCacheKey, columns);
          })
          .catch(() => {});
      }
    }
    if (!onDemandOnlyColumns && !tableNameCompletion) {
      for (const refTable of completionContext.referencedTables) {
        if (isVirtualCompletionTableReference(refTable)) continue;
        if (refTable.columns && refTable.columns.length > 0) continue;
        const cacheKey = completionCacheKey(refTable, scope);
        if (cacheKey === qualifiedColumnCacheKey) continue;
        if (cachedColumnsByTable.has(cacheKey)) continue;
        const target = completionMetadataTarget(refTable, scope);
        if (!target) continue;
        void refreshCompletionColumnsForEditor(connectionId, target.database, refTable.name, target.schema, target.catalog, refTable)
          .then((columns) => {
            if (columns.length > 0) cachedColumnsByTable.set(cacheKey, columns);
          })
          .catch(() => {});
      }
    }
    if (!tableNameCompletion && completionContext.suggestJoinConditions && completionContext.referencedTables.length > 0) {
      void ensureForeignKeysForTables(completionContext.referencedTables);
    }
  }

  function shouldLoadCompletionObjects(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
    // Doris/StarRocks external catalogs currently expose table and column
    // metadata through catalog-aware APIs. The generic routine/object endpoint
    // is catalogless and would query the internal catalog, aborting completion.
    if (props.catalog) return false;
    const routineContext = completionContext.suggestRoutines || completionContext.exclusiveRoutineSuggestions || (!!completionContext.qualifier && !completionContext.exclusiveColumnSuggestions);
    return routineContext && !isReferencedTableQualifier(completionContext);
  }

  /**
   * Databases whose qualified routine completion treats the first qualifier as a
   * package (Oracle) or as a package-or-schema in A compatibility mode
   * (openGauss). The backend re-validates: non-package parents fall through to
   * the ordinary routine search, so routing is safe even when the compatibility
   * map is not yet warm. openGauss keeps the package-aware routing while the
   * mode is unknown (cold start, so A-mode completion works immediately after
   * connect) and once the mode is known to be A; a known B/PG mode skips the
   * extra package-style queries entirely.
   */
  function usesPackageAwareRoutineCompletion(): boolean {
    if (props.databaseType === "oracle") return true;
    if (props.databaseType !== "opengauss") return false;
    const mode = connectionStore.databaseCompatibilityMode(props.connectionId, props.database)?.trim().toUpperCase();
    return mode === undefined || mode === "A";
  }

  function oracleRoutineCompletionTargets(completionContext: ReturnType<typeof getSqlCompletionContext>): RoutineCompletionTarget[] {
    const parts = (completionContext.qualifierParts?.length ? completionContext.qualifierParts : completionContext.qualifier?.split("."))?.filter(Boolean) ?? [];
    if (parts.length === 0) {
      // Oracle resolves unqualified routines across all schemas (owner semantics).
      // openGauss keeps the PG search_path scope for the unqualified case.
      if (props.databaseType === "oracle") return [{ schema: props.schema, globalSearch: true }];
      return [{ schema: props.schema }];
    }
    if (parts.length === 1) {
      return [{ schema: props.schema, parentName: parts[0] }, { schema: parts[0] }];
    }
    return [{ schema: parts[parts.length - 2], parentName: parts[parts.length - 1] }];
  }

  function routineCompletionTargetForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope) {
    return resolveSqlCompletionRoutineLookupTarget({
      currentDatabase: scope.database,
      currentSchema: scope.schema,
      supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
      completionContext,
    });
  }

  function routineCompletionScopeForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope): CompletionMetadataScope {
    if (usesPackageAwareRoutineCompletion()) return scope;
    const target = routineCompletionTargetForContext(completionContext, scope);
    return { database: target.database, schema: target.schema };
  }

  function lookupLocalCompletionObjectsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope): SqlCompletionObject[] {
    if (!props.connectionId || props.database == null) return [];
    if (usesPackageAwareRoutineCompletion()) {
      return connectionStore.lookupLocalCompletionObjects(props.connectionId, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES);
    }
    const target = routineCompletionTargetForContext(completionContext, scope);
    return connectionStore.lookupLocalCompletionObjects(props.connectionId, target.database, target.mask, MAX_COMPLETION_TABLES, target.schema);
  }

  async function listCompletionObjectsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope): Promise<SqlCompletionObject[]> {
    if (!props.connectionId || props.database == null) return [];
    const objectKinds = completionObjectKindsForContext(completionContext);
    if (!usesPackageAwareRoutineCompletion()) {
      const target = routineCompletionTargetForContext(completionContext, scope);
      return connectionStore.listCompletionObjects(props.connectionId, target.database, target.mask, MAX_COMPLETION_TABLES, target.schema, undefined, false, scope.schema, objectKinds);
    }
    const groups = await Promise.all(
      oracleRoutineCompletionTargets(completionContext).map((target) => connectionStore.listCompletionObjects(props.connectionId!, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES, target.schema, target.parentName, target.globalSearch, scope.schema, objectKinds)),
    );
    return groups.reduce((objects, group) => mergeCompletionObjects(objects, group), [] as SqlCompletionObject[]);
  }

  function completionObjectKindsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>): CompletionAssistantObjectKind[] {
    if (completionContext.contextKind === "exec") return ["procedure"];
    if (completionContext.suggestColumns && completionContext.referencedTables.length > 0 && !completionContext.qualifier) return ["function"];
    return ["routine"];
  }

  async function performAsyncCompletionWithResult(epoch: number, completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number, scope: CompletionMetadataScope) {
    const localOnlyMetadata = usesLocalOnlyCompletionMetadata();
    const onDemandOnlyColumns = usesOnDemandOnlyCompletionColumns();
    // Handle INSERT column list: fetch columns for the target table
    let insertColumnsByTable = new Map<string, SqlCompletionColumn[]>();
    if (completionContext.insertTable) {
      try {
        const insertDatabase = (supportsDatabaseSchemaQualifierCompletion() ? completionContext.insertDatabase : undefined) ?? scope.database;
        const insertCols = await listCompletionColumnsForEditor(props.connectionId!, insertDatabase, completionContext.insertTable, completionContext.insertSchema ?? scope.schema);
        if (epoch !== completionEpoch) return null;
        if (insertCols.length > 0) {
          const insertSchema = completionContext.insertSchema ?? scope.schema;
          const insertKey = completionCacheKey({ name: completionContext.insertTable, database: completionContext.insertDatabase, schema: insertSchema }, scope);
          insertColumnsByTable.set(insertKey, insertCols);
        }
      } catch {
        // ignore
      }
    }

    let databaseNames = localCompletionDatabaseNames(completionContext);
    let currentDatabaseSchemaNames = localCompletionSchemasForDatabaseDisambiguation(completionContext, databaseNames, scope);
    const mayCompleteDatabaseSchema = mayCompleteDatabaseSchemaQualifier(completionContext);
    if (!localOnlyMetadata && supportsDatabaseNameCompletion(props.databaseType) && completionContext.suggestTables && !completionContext.insertTable && (!completionContext.qualifier || mayCompleteDatabaseSchema)) {
      const [databasesResult, schemasResult] = await Promise.allSettled([connectionStore.listCompletionDatabases(props.connectionId!), mayCompleteDatabaseSchema ? connectionStore.listCompletionSchemas(props.connectionId!, scope.database) : Promise.resolve(currentDatabaseSchemaNames)]);
      databaseNames = databasesResult.status === "fulfilled" ? databasesResult.value : [];
      if (schemasResult.status === "fulfilled") currentDatabaseSchemaNames = mergeSqlCompletionQualifierNames(scope.schema ? [scope.schema] : [], schemasResult.value);
      if (epoch !== completionEpoch) return null;
    }
    const schemaLookupDatabase = resolveSqlCompletionSchemaLookupDatabase({
      supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
      completionContext,
      knownDatabases: databaseNames,
      knownSchemas: currentDatabaseSchemaNames,
    });
    const shouldLoadTables = !schemaLookupDatabase && (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext)));
    const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
      currentDatabase: scope.database,
      currentSchema: scope.schema,
      supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
      supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
      completionContext,
      knownDatabases: databaseNames,
    });
    const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
    let tables = schemaLookupDatabase
      ? []
      : shouldLoadTables
        ? localOnlyMetadata
          ? connectionStore.lookupLocalCompletionTables(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, globalOracleTableSearch ? undefined : tableLookupTarget.schema, props.catalog)
          : await listCompletionTablesWithLatencyBudget(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, tableLookupTarget.schema, globalOracleTableSearch, props.catalog, scope.schema)
        : completionMetadata.cachedTables;
    if (localOnlyMetadata && tables.length === 0 && supportsDatabaseSchemaQualifierCompletion() && (completionContext.qualifierParts?.length ?? 0) >= 2 && allowsOnDemandQualifiedTableCompletion(completionContext.prefix)) {
      tables = await listCompletionTablesWithLatencyBudget(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT, tableLookupTarget.schema, false, props.catalog, scope.schema);
    }
    if (epoch !== completionEpoch) return null;

    const shouldLoadObjects = shouldLoadCompletionObjects(completionContext);
    const completionObjectScope = routineCompletionScopeForContext(completionContext, scope);
    const scopedCachedCompletionObjects = completionObjectsForScope(completionObjectScope);
    let completionObjects = shouldLoadObjects ? (localOnlyMetadata ? lookupLocalCompletionObjectsForContext(completionContext, scope) : await listCompletionObjectsForContext(completionContext, scope)) : scopedCachedCompletionObjects;
    if (epoch !== completionEpoch) return null;

    if (!props.catalog && props.databaseType !== "oracle" && !localOnlyMetadata && completionContext.qualifier && completionObjects.length === 0) {
      const target = routineCompletionTargetForContext(completionContext, scope);
      const schemaObjects = await connectionStore.listCompletionObjects(props.connectionId!, target.database, target.mask, MAX_COMPLETION_TABLES, target.schema, undefined, false, scope.schema);
      if (schemaObjects.length > 0) {
        completionObjects = schemaObjects;
      }
      if (epoch !== completionEpoch) return null;
    }
    cachedCompletionObjectsByScope.set(completionObjectScopeKey(completionObjectScope), mergeCompletionObjects(scopedCachedCompletionObjects, completionObjects));

    // Fetch schemas for schema completion
    let schemaNames: string[] = [];
    if (completionContext.suggestTables && !completionContext.insertTable && (schemaLookupDatabase || !completionContext.qualifier)) {
      const database = schemaLookupDatabase ?? scope.database;
      if (localOnlyMetadata) {
        const schemas = connectionStore.lookupLocalCompletionSchemas(props.connectionId!, database, completionContext.prefix, MAX_COMPLETION_TABLES);
        schemaNames = schemaLookupDatabase ? schemas : mergeSqlCompletionQualifierNames(schemas, databaseNames);
      } else {
        try {
          const schemas = await connectionStore.listCompletionSchemas(props.connectionId!, database);
          schemaNames = schemaLookupDatabase ? schemas : mergeSqlCompletionQualifierNames(schemas, databaseNames);
          if (epoch !== completionEpoch) return null;
        } catch {
          schemaNames = schemaLookupDatabase ? [] : databaseNames;
        }
      }
    }

    // If qualifier didn't match any table names, try it as a schema name
    let qualifierIsSchema = false;
    if (completionContext.qualifier && !schemaLookupDatabase && !tableLookupTarget.qualifierDatabase && !isReferencedTableQualifier(completionContext) && tables.length === 0 && (completionContext.suggestTables || completionContext.exclusiveColumnSuggestions)) {
      let schemaTables = connectionStore.lookupLocalCompletionTables(props.connectionId!, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier, props.catalog);
      if (!localOnlyMetadata) {
        schemaTables = await listCompletionTablesWithLatencyBudget(props.connectionId!, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier, false, props.catalog, scope.schema);
      } else if (schemaTables.length === 0 && allowsOnDemandQualifiedTableCompletion(completionContext.prefix)) {
        schemaTables = await listCompletionTablesWithLatencyBudget(props.connectionId!, scope.database, completionContext.prefix, PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT, completionContext.qualifier, false, props.catalog, scope.schema);
      }
      if (schemaTables.length > 0) {
        tables = schemaTables;
        qualifierIsSchema = true;
      }
      if (epoch !== completionEpoch) return null;
    }

    // Collect referenced tables — enrich with schema from filtered table lookup
    let refs = completionContext.referencedTables.map((rt) => {
      if (usesOracleSessionCompletionColumns(rt.schema)) return rt;
      if (!rt.schema) {
        const cached = tables.find((t) => t.name.toLowerCase() === rt.name.toLowerCase());
        if (cached && cached.schema) {
          return { ...rt, schema: cached.schema };
        }
      }
      return rt;
    });
    const unresolvedRefs = refs.filter((rt) => !usesOracleSessionCompletionColumns(rt.schema) && !rt.schema && !rt.columns && !isVirtualCompletionTableReference(rt));
    if (!localOnlyMetadata && unresolvedRefs.length > 0) {
      const lookupGroups = await Promise.all(
        unresolvedRefs.map((rt) => {
          const target = completionMetadataTarget(rt, scope);
          return connectionStore.listCompletionTables(props.connectionId!, target?.database ?? scope.database, rt.name, 20, target?.schema ?? scope.schema, false, scope.schema, target?.catalog ?? props.catalog);
        }),
      );
      if (epoch !== completionEpoch) return null;
      const lookupTables = lookupGroups.flat();
      refs = refs.map((rt) => {
        if (usesOracleSessionCompletionColumns(rt.schema)) return rt;
        if (rt.schema || rt.columns) return rt;
        const matched = lookupTables.find((table) => table.name.toLowerCase() === rt.name.toLowerCase());
        return matched?.schema ? { ...rt, schema: matched.schema } : rt;
      });
    }

    // If no referenced tables but qualifier exists, infer table from tables list
    if (refs.length === 0 && completionContext.qualifier) {
      const q = completionContext.qualifier.toLowerCase();
      const matched = tables.filter((t) => t.name.toLowerCase() === q || t.name.toLowerCase().endsWith("." + q));
      refs = matched.map((t) => ({ name: t.name, schema: t.schema }));
    }

    const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
    if (qualifiedColumnTarget && !refs.some((ref) => completionTablesMatch(ref, qualifiedColumnTarget))) {
      refs.push(qualifiedColumnTarget);
    }

    // Populate CTE columns from parsed definitions
    const cteDefs = extractCteDefinitions(fullDoc);
    for (const refTable of refs) {
      if (refTable.columns) continue;
      const cteDef = cteDefs.find((c) => c.name.toLowerCase() === refTable.name.toLowerCase());
      if (cteDef) {
        refTable.columns = cteDef.columns;
      }
    }

    const tableNameCompletion = isTableNameCompletionContext(completionContext);
    const shouldFetchColumnsForCompletion = !tableNameCompletion && (!onDemandOnlyColumns || completionContext.suggestColumns || completionContext.exclusiveColumnSuggestions || !!completionContext.insertTable);
    const hasQualifiedColumnPrefix = (props.databaseType === "postgres" || props.databaseType === "mysql") && completionContext.qualifier && completionContext.prefix.length >= 2 && isReferencedTableQualifier(completionContext);
    const columnRefs = hasQualifiedColumnPrefix
      ? refs.filter((refTable) => refTable.alias?.toLowerCase() === completionContext.qualifier!.toLowerCase() || refTable.name.toLowerCase() === completionContext.qualifier!.toLowerCase() || (!!qualifiedColumnTarget && completionTablesMatch(refTable, qualifiedColumnTarget)))
      : refs.slice(0, 4);
    if (shouldFetchColumnsForCompletion) {
      await Promise.all(
        columnRefs.map(async (refTable) => {
          if (isVirtualCompletionTableReference(refTable)) return;
          if (refTable.columns && refTable.columns.length > 0) return;
          const cacheKey = completionCacheKey(refTable, scope);
          const prefixCompletion = hasQualifiedColumnPrefix ? completionContext.prefix : undefined;
          const prefixCacheKey = prefixCompletion ? completionPrefixCacheKey(refTable, scope, prefixCompletion) : undefined;
          if (prefixCompletion ? lookupCachedPrefixColumns(refTable, scope, prefixCompletion) : cachedColumnsByTable.has(cacheKey)) return;
          try {
            const target = completionMetadataTarget(refTable, scope);
            if (!target) return;
            const columns = await listCompletionColumnsForEditor(props.connectionId!, target.database, refTable.name, target.schema, target.catalog, refTable, prefixCompletion);
            if (epoch !== completionEpoch) return;
            if (columns.length === 0) return;
            if (prefixCacheKey) cachedPrefixColumnsByTable.set(prefixCacheKey, columns);
            else cachedColumnsByTable.set(cacheKey, columns);
          } catch (e) {
            console.error(`[DBX] Failed to load columns for ${cacheKey}:`, e);
          }
        }),
      );
    }
    if (epoch !== completionEpoch) return null;

    if (!tableNameCompletion && completionContext.suggestJoinConditions && refs.length > 0) {
      await ensureForeignKeysForTables(refs.filter((table) => !("columns" in table) || !table.columns || table.columns.length === 0));
      if (epoch !== completionEpoch) return null;
    }

    // Build columnsByTable — from cache or CTE definitions
    const columnsByTable = new Map<string, SqlCompletionColumn[]>();
    const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>();
    if (insertColumnsByTable.size > 0) {
      for (const [key, cols] of insertColumnsByTable.entries()) {
        columnsByTable.set(key, cols);
      }
    } else {
      for (const refTable of refs) {
        if (hasQualifiedColumnPrefix && !columnRefs.includes(refTable)) continue;
        if (refTable.columns && refTable.columns.length > 0) {
          const key = refTable.name;
          columnsByTable.set(
            key,
            refTable.columns.map((name) => ({
              name,
              table: refTable.name,
              dataType: undefined,
            })),
          );
          continue;
        }
        const cacheKey = completionCacheKey(refTable, scope);
        const prefixCompletion =
          (props.databaseType === "postgres" || props.databaseType === "mysql") &&
          completionContext.qualifier &&
          completionContext.prefix.length >= 2 &&
          isReferencedTableQualifier(completionContext) &&
          (refTable.alias?.toLowerCase() === completionContext.qualifier.toLowerCase() || refTable.name.toLowerCase() === completionContext.qualifier.toLowerCase())
            ? completionContext.prefix
            : undefined;
        const cached = (prefixCompletion ? lookupCachedPrefixColumns(refTable, scope, prefixCompletion) : undefined) ?? cachedColumnsByTable.get(cacheKey);
        if (cached) {
          columnsByTable.set(cacheKey, cached);
        }
        let cachedForeignKeys = cachedForeignKeysByTable.get(cacheKey);
        if (!cachedForeignKeys) {
          const target = completionMetadataTarget(refTable, scope);
          cachedForeignKeys = target ? connectionStore.lookupLocalCompletionForeignKeys(props.connectionId!, target.database, refTable.name, target.schema) : [];
          if (cachedForeignKeys.length > 0) cachedForeignKeysByTable.set(cacheKey, cachedForeignKeys);
        }
        if (cachedForeignKeys) {
          foreignKeysByTable.set(cacheKey, cachedForeignKeys);
        }
      }
    }

    const effectiveContext = qualifierIsSchema
      ? {
          ...completionContext,
          qualifier: undefined,
          suggestTables: true,
          suggestColumns: false,
          exclusiveColumnSuggestions: false,
        }
      : completionContext;

    const items = buildSqlCompletionItemsFromContext(effectiveContext, {
      tables,
      objects: completionObjects,
      columnsByTable,
      foreignKeysByTable,
      schemas: schemaNames,
      translations: completionTranslations.value,
      snippets: settingsStore.editorSettings.snippets,
      dialect: props.dialect,
      databaseType: snippetDatabaseType.value,
      driverProfile: sqlDriverProfile.value,
      currentSchema: scope.schema,
      keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
      functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
      autoAliasTables: settingsStore.editorSettings.autoAliasTables,
      quoteIdentifiers: settingsStore.editorSettings.generateSqlQuoteIdentifiers,
    });

    return buildSqlCompletionResult(items, completionContext, fullDoc, position);
  }

  function isReferencedTableQualifier(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
    if (!completionContext.qualifier) return false;
    const qualifier = completionContext.qualifier.toLowerCase();
    const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
    return completionContext.referencedTables.some((table) => table.alias?.toLowerCase() === qualifier || table.name.toLowerCase() === qualifier || (!!qualifiedColumnTarget && completionTablesMatch(table, qualifiedColumnTarget)));
  }

  function isTableNameCompletionContext(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
    return completionContext.suggestTables || completionContext.exclusiveTableSuggestions;
  }

  function refreshActiveSqlCompletion(fullDoc: string, position: number, completionContext: ReturnType<typeof getSqlCompletionContext>) {
    const currentView = view.value;
    if (!currentView || runtime.codeMirrorCompletionStatus?.(currentView.state) !== "active") return;
    if (currentView.state.doc.toString() !== fullDoc || currentView.state.selection.main.head !== position) return;
    const currentContext = getSqlCompletionContext(fullDoc, position);
    if (currentContext.prefix !== completionContext.prefix || currentContext.contextKind !== completionContext.contextKind) return;
    scheduleSqlCompletionStart(currentView);
  }

  return {
    triggerSqlCompletion,
    markCompletionAccepted,
    shouldTriggerSqlCompletionForPosition,
    scheduleSqlCompletionStart,
    provideSqlCompletions,
    consumeSqlCompletionAutoStartSuppression,
    scheduleDeferredCompletionTrigger,
    clearDeferredCompletionTrigger,
    invalidateRequests() {
      completionEpoch++;
    },
    get activeOrigin() {
      return activeCompletionOrigin;
    },
    set activeOrigin(origin: SqlCompletionTriggerOrigin | null) {
      activeCompletionOrigin = origin;
    },
    get suppressAutoStartUntil() {
      return suppressNextSqlCompletionAutoStartUntil;
    },
    set suppressAutoStartUntil(until: number) {
      suppressNextSqlCompletionAutoStartUntil = until;
    },
  };
}

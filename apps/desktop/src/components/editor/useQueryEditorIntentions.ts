import { ref, onBeforeUnmount, type ShallowRef } from "vue";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { analyzeIntentionActions, prepareExpandWildcardContext, buildExpandWildcardReplacement, type IntentionAction } from "@/lib/editor/sqlIntentionActions";
import { loadTableMetadata } from "@/lib/metadata/tableMetadataCache";
import type { QueryEditorProps } from "./queryEditorTypes";

export // ==================== Intention Popup ====================

interface IntentionPopupState {
  visible: boolean;
  // 直接复用 IntentionAction 类型，避免手动重声明导致 replacements 等字段丢失（TS2551）
  actions: IntentionAction[];
  position: { x: number; y: number };
  selectedIndex: number;
}

interface QueryEditorIntentionsOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  sqlBehaviorDialect: () => QueryEditorProps["dialect"];
  focusEditor: () => void;
}

export function useQueryEditorIntentions(options: QueryEditorIntentionsOptions) {
  const { props, view, sqlBehaviorDialect, focusEditor } = options;
  const intentionPopup = ref<IntentionPopupState | null>(null);

  function closeIntentionPopup() {
    document.removeEventListener("keydown", onIntentionPopupKey);
    intentionPopup.value = null;
    focusEditor();
  }

  function onIntentionPopupKey(e: KeyboardEvent) {
    if (!intentionPopup.value?.visible) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        closeIntentionPopup();
        break;
      case "ArrowDown":
        e.preventDefault();
        intentionPopup.value.selectedIndex = Math.min(intentionPopup.value.selectedIndex + 1, intentionPopup.value.actions.length - 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        intentionPopup.value.selectedIndex = Math.max(intentionPopup.value.selectedIndex - 1, 0);
        break;
      case "Enter":
        e.preventDefault();
        executeIntentionAction(intentionPopup.value.actions[intentionPopup.value.selectedIndex]);
        break;
    }
  }

  function executeIntentionAction(action: IntentionPopupState["actions"][number]) {
    if (!intentionPopup.value) return;
    closeIntentionPopup();

    const currentView = view.value;
    if (!currentView) return;

    switch (action.kind) {
      case "expand_wildcard": {
        const sql = currentView.state.doc.toString();
        const cursor = currentView.state.selection.main.head;
        void (async () => {
          try {
            const ctx = prepareExpandWildcardContext(sql, cursor, props.databaseType, sqlBehaviorDialect());
            if (!ctx) return;

            const replacement = await buildExpandWildcardReplacement(props.databaseType, ctx.rowSources, async (source) => {
              const schema = source.metadataTarget?.schema;
              const tableName = source.metadataTarget?.table ?? source.name;
              if (!tableName) return [];
              const result = await loadTableMetadata({
                connectionId: props.connectionId ?? "",
                database: props.database ?? "",
                schema,
                tableName,
                databaseType: props.databaseType ?? "mysql",
                force: false,
              });
              return result.metadata.columns.map((c) => c.name);
            });
            const v = view.value;
            if (!v || v.state.doc.toString() !== sql) return;
            v.dispatch({ changes: { from: ctx.starSpan.start, to: ctx.starSpan.end, insert: replacement } });
          } catch {
            // metadata load failed
          }
        })();
        break;
      }
      case "qualify_identifier":
      case "unqualify_identifier":
        currentView.dispatch({
          changes: { from: action.span.start, to: action.span.end, insert: action.replacement },
        });
        break;

      case "batch_qualify_identifiers": {
        // 按从后往前的顺序逐一替换，避免 offset 漂移
        const reps = action.replacements ?? [];
        for (let i = reps.length - 1; i >= 0; i--) {
          const r = reps[i];
          currentView.dispatch({
            changes: { from: r.span.start, to: r.span.end, insert: r.replacement },
          });
        }
        break;
      }
    }
  }

  function handleSqlIntentionActions(currentView: EditorViewType): boolean {
    if (props.readOnly) return false;
    try {
      const sql = currentView.state.doc.toString();
      const sel = currentView.state.selection.main;

      const actions = analyzeIntentionActions({
        sql,
        cursor: sel.head,
        databaseType: props.databaseType,
        dialect: sqlBehaviorDialect(),
        selection: sel.from !== sel.to ? { from: sel.from, to: sel.to } : undefined,
      });

      if (actions.length === 0) return false;

      // 计算光标视口坐标，用于定位弹出菜单
      const coords = currentView.coordsAtPos(sel.head);
      if (!coords) return false;

      // 显示弹出菜单（参考 DataGrip Alt+Enter 意图操作弹出菜单）
      intentionPopup.value = {
        visible: true,
        actions,
        position: { x: coords.right + 8, y: coords.bottom + 4 },
        selectedIndex: 0,
      };
      document.addEventListener("keydown", onIntentionPopupKey);
      return true;
    } catch (err) {
      console.error("[SQL Intention] error:", err);
      return false;
    }
  }

  onBeforeUnmount(() => document.removeEventListener("keydown", onIntentionPopupKey));

  return { intentionPopup, closeIntentionPopup, executeIntentionAction, handleSqlIntentionActions };
}

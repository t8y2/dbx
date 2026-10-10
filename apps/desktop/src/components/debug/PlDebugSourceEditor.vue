<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import * as langSql from "@codemirror/lang-sql";
import { Loader2 } from "@lucide/vue";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { createPlDebugEditorExtension, refreshPlDebugEditorEffect } from "@/lib/editor/codemirrorPlDebugEditor";
import { createPlDebugStepKeyBindings, type PlDebugStepCommand } from "@/lib/editor/plDebugStepShortcut";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { loadObjectSourceWithRoutineFallback } from "@/lib/table/objectSourceLoad";
import { useTheme } from "@/composables/useTheme";
import { useConnectionStore } from "@/stores/connectionStore";
import { usePlDebugStore, type PlDebugSessionTarget } from "@/stores/plDebugStore";
import { useSettingsStore } from "@/stores/settingsStore";
import * as api from "@/lib/backend/api";
import type { DatabaseType, ObjectSourceKind } from "@/types/database";

/**
 * 调试 tab 里的只读源码视图：被测对象的源码 + 行号区断点 + 当前执行行高亮。
 *
 * 源码按"原样"展示（不做 format，也不加 CREATE OR REPLACE 前缀），因为
 * DBMS_DEBUG 的行号就是数据库侧源码的行号，任何改写都会让断点错位。包成员取包体
 * 源码（与 ODC 的 `getContentFromPL` 一致，包成员的运行行号是包体行号）；匿名块直接
 * 用启动请求里提交的源码。
 */
const { t } = useI18n();
const store = usePlDebugStore();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const { isDark, themePalette } = useTheme();

/** 调试单步命令 → store 动作；与 App.vue 的窗口级分支共用同一份命令语义。 */
const plDebugStepRunners: Record<PlDebugStepCommand, () => void> = {
  stepInto: () => void store.stepIn(),
  stepOut: () => void store.stepOut(),
  stepOver: () => void store.stepOver(),
};

/** 快捷键可在调试会话存续期间被改，因此单步键位放进可重配置的 compartment。 */
const plDebugStepKeymapCompartment = new Compartment();

/**
 * `Prec.highest` 是必需项：`basicSetup` 里的 `defaultKeymap` 把 `Mod-i` 绑给了
 * `selectParentSyntax`，优先级不够就会被它先命中（详见 createPlDebugStepKeyBindings）。
 */
function plDebugStepKeymapContent() {
  return Prec.highest(
    keymap.of(
      createPlDebugStepKeyBindings({
        shortcuts: settingsStore.editorSettings.shortcuts,
        // 与工具栏按钮同一套可用性条件：没有停住的会话时让出键位。
        canStep: () => store.hasSession && !store.busy,
        run: (command) => plDebugStepRunners[command](),
      }),
    ),
  );
}

function plDebugStepKeymapExtension() {
  return plDebugStepKeymapCompartment.of(plDebugStepKeymapContent());
}

const host = ref<HTMLElement | null>(null);
const loadedSource = ref("");
const loading = ref(false);
const loadError = ref<string | null>(null);
let loadToken = 0;
let editorView: EditorView | null = null;
let mountGeneration = 0;

function currentCustomThemeColors() {
  const settings = settingsStore.editorSettings;
  if (settings.theme !== "custom") return settings.customThemeColors;
  const activeTheme = settings.customThemes?.find((theme) => theme.id === settings.activeCustomThemeId) || settings.customThemes?.[0];
  return activeTheme?.colors ?? settings.customThemeColors;
}

function sessionDatabaseType(): DatabaseType | undefined {
  const connectionId = store.connectionId;
  if (!connectionId) return undefined;
  return effectiveDatabaseTypeForConnection(connectionStore.getConfig(connectionId));
}

/** Package members have no ALL_SOURCE row of their own; their body carries the line numbers. */
const sourceRequest = computed<{ name: string; objectType: ObjectSourceKind } | null>(() => {
  const target = store.target;
  if (!target || !store.connectionId) return null;
  const objectType = target.objectType.toUpperCase();
  if (objectType === "ANONYMOUS") return null;
  if (target.packageName) return { name: target.packageName, objectType: "PACKAGE_BODY" };
  if (!target.objectName) return null;
  return { name: target.objectName, objectType: objectType as ObjectSourceKind };
});

const documentText = computed(() => {
  const target = store.target;
  if (!target) return "";
  if (target.objectType.toUpperCase() === "ANONYMOUS") return target.source ?? "";
  return loadedSource.value;
});

const statusMessage = computed(() => {
  if (loadError.value) return loadError.value;
  if (!store.target) return t("plDebug.source.unavailable");
  if (!documentText.value.trim()) return t("plDebug.source.unavailable");
  return "";
});

/**
 * The line to highlight, only while the session is parked inside the object this
 * view shows: stepping into another routine must clear it (ODC's `pl.isActive`).
 */
function programMatchesTarget(program: string, target: PlDebugSessionTarget): boolean {
  if (target.objectType.toUpperCase() === "ANONYMOUS") return true;
  const normalized = program.trim().toUpperCase();
  if (normalized === "") return false;
  const objectName = (target.objectName ?? "").trim().toUpperCase();
  if (objectName === "") return false;
  return normalized === objectName || normalized.endsWith(`.${objectName}`);
}

const activeCurrentLine = computed<number | null>(() => {
  if (!store.hasSession) return null;
  const line = store.currentLine;
  const target = store.target;
  if (line === null || !target) return null;
  const program = store.currentProgram;
  if (program !== null && !programMatchesTarget(program, target)) return null;
  return line;
});

// The launcher may leave `loadedSource` from a previous session; the debug tab is
// reused across sessions, so the request identity decides when to reload.
watch(
  () => [sourceRequest.value, store.connectionId, store.database, store.target?.schema] as const,
  async () => {
    const request = sourceRequest.value;
    const connectionId = store.connectionId;
    const database = store.database;
    const token = ++loadToken;
    loadedSource.value = "";
    loadError.value = null;
    loading.value = false;
    if (!request || !connectionId || !database) return;
    const target = store.target;
    loading.value = true;
    try {
      const { source } = await loadObjectSourceWithRoutineFallback(api.getObjectSource, connectionId, database, target?.schema || database, request.name, request.objectType);
      if (token !== loadToken) return;
      loadedSource.value = source.source ?? "";
    } catch (caught) {
      if (token !== loadToken) return;
      loadError.value = String(caught);
    } finally {
      if (token === loadToken) loading.value = false;
    }
  },
  { immediate: true },
);

/** Pushes the store's breakpoint/current-line snapshot into the live editor. */
function refreshEditorDecorations() {
  if (!editorView) return;
  editorView.dispatch({ effects: refreshPlDebugEditorEffect.of(null) });
}

function destroyEditor() {
  ++mountGeneration;
  editorView?.destroy();
  editorView = null;
}

async function mountEditor() {
  const text = documentText.value;
  const element = host.value;
  if (!text.trim() || !element) {
    destroyEditor();
    return;
  }
  const generation = ++mountGeneration;
  editorView?.destroy();
  editorView = null;
  const settings = settingsStore.editorSettings;
  const databaseType = sessionDatabaseType();
  const theme = await loadEditorTheme(settings.theme, isDark.value ? "dark" : "light", currentCustomThemeColors(), themePalette.value);
  if (generation !== mountGeneration || host.value !== element) return;
  const state = EditorState.create({
    doc: text,
    extensions: [
      plDebugStepKeymapExtension(),
      basicSetup,
      EditorState.readOnly.of(true),
      langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType) }),
      theme,
      editorFontTheme(EditorView, settings.fontSize, settings.fontFamily, { fixedHeight: true, scrollable: true }),
      // 断点/当前行装饰放在主题之后，确保断点圆点与整行高亮不被编辑器主题覆盖。
      createPlDebugEditorExtension({
        getSnapshot: () => ({ breakpointLines: store.breakpointLines, currentLine: activeCurrentLine.value }),
        isEnabled: () => store.hasSession && store.target !== null,
        toggleBreakpoint: (lineNum: number) => {
          // applyBreakpoints 已经写进 store.error（工具栏会显示），这里只需吞掉 rejection。
          void store.toggleBreakpoint(lineNum).catch(() => {});
        },
      }),
    ],
  });
  editorView = new EditorView({ state, parent: element });
}

onMounted(() => {
  void mountEditor();
});

// Mount after the DOM shows the container: CodeMirror measures on creation, and
// `v-show` keeps this hidden while the source is still loading.
watch(
  [documentText, isDark],
  () => {
    void mountEditor();
  },
  { flush: "post" },
);

// 断点与当前行只以装饰形式推送：调试期间文档本身不变。
// 订阅 store.breakpointLines（计算属性）而不是 breakpoints 数组本身，否则
// applyBreakpoints 的 push 不会改变数组引用，装饰就不会重画。
watch([() => store.breakpointLines, activeCurrentLine, () => store.currentProgram, () => store.hasSession, () => store.target], refreshEditorDecorations);

// 设置里改键后立刻生效（与 QueryEditor 的 runKeymapComp 同一范式），
// 不必等重新挂载编辑器。
watch(
  () => settingsStore.editorSettings.shortcuts,
  () => {
    if (!editorView) return;
    editorView.dispatch({ effects: plDebugStepKeymapCompartment.reconfigure(plDebugStepKeymapContent()) });
  },
);

onBeforeUnmount(() => {
  destroyEditor();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div v-if="loading" class="flex flex-1 items-center justify-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 class="h-3.5 w-3.5 animate-spin" />
      {{ t("plDebug.source.loading") }}
    </div>
    <div v-else-if="statusMessage" class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      {{ statusMessage }}
    </div>
    <div v-show="!loading && !statusMessage" ref="host" class="pl-debug-source-editor min-h-0 flex-1 overflow-hidden"></div>
  </div>
</template>

<style scoped>
.pl-debug-source-editor :deep(.cm-editor),
.pl-debug-source-editor :deep(.cm-scroller) {
  height: 100%;
}
</style>

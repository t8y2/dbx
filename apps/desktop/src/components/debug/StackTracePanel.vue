<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FileCode } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { frameBelongsToTarget, frameSourceCandidates } from "@/lib/debug/plDebugFrameSource";
import { loadPlDebugObjectSource } from "@/lib/debug/plDebugSourceAlignment";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/api";
import type { PlDebugFrame } from "@/lib/backend/pl-debug-tauri";

interface StackFrame {
  /**
   * Frame number DBMS_DEBUG uses, and the number this panel selects: the agent's
   * listing is innermost-first, so the **array index** is the frame number (0 = the
   * stopped frame). `PlDebugFrame.stackDepth` counts from the outermost frame
   * instead and is deliberately not used as the number.
   */
  index: number;
  program: string;
  line: number | null;
  /**
   * The structured entry this row came from, or null for a row of the raw-text
   * fallback. The cross-object source view needs `program`/`programOwner` in their
   * original shape, so the row keeps its payload rather than re-deriving it.
   */
  payload: PlDebugFrame | null;
}

const { t } = useI18n();
const store = usePlDebugStore();
/** Frame whose source is being loaded, so its button can show the pending state. */
const loadingFrame = ref<number | null>(null);
/** Local failure of the view-source action (a frame with no object to load). */
const loadError = ref<string | null>(null);

/**
 * DBMS_DEBUG backtrace listings vary by server ("#0 PKG.PROC line 12",
 * "PKG.PROC at line 12", …), so the parser keeps every line that names a frame
 * or a line number and reads the program name out of it. It is the fallback for
 * an agent that answered with the raw text but no structured `frames`.
 */
function parseBacktrace(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const bracketed = /^\[Line\s+(\d+)\]\s+(.+)$/i.exec(trimmed);
    if (bracketed) {
      frames.push({ index: frames.length, program: bracketed[2]!, line: Number(bracketed[1]), payload: null });
      continue;
    }
    const numbered = /^#\s*(\d+)\s*[:.)-]?\s*(.*)$/.exec(trimmed);
    const rest = numbered ? (numbered[2] ?? "") : trimmed;
    const lineMatch = /\bline\s*[:=#]?\s*(\d+)/i.exec(rest) ?? /\(\s*(\d+)\s*\)\s*$/.exec(rest) ?? /:\s*(\d+)\s*$/.exec(rest);
    if (!numbered && !lineMatch) continue;
    const program = rest
      .replace(/\s*(?:at\s+)?\bline\s*[:=#]?\s*\d+.*$/i, "")
      .replace(/\(\s*\d+\s*\)\s*$/, "")
      .replace(/:\s*\d+\s*$/, "")
      .trim();
    frames.push({
      index: numbered ? Number(numbered[1]) : frames.length,
      program: program || trimmed,
      line: lineMatch ? Number(lineMatch[1]) : null,
      payload: null,
    });
  }
  return frames;
}

/**
 * A structured frame list is preferred when the snapshot carries one: the agent
 * publishes `frames` alongside the raw backtrace text, and `PlDebugStatus.frames`
 * is typed — so a renamed field fails the type check here instead of silently
 * degrading to the text parser (this file used to read a non-existent `index`).
 */
const snapshotFrames = computed<StackFrame[]>(() => {
  const raw = store.status?.frames;
  if (!Array.isArray(raw)) return [];
  return raw.map((payload, position) => {
    const line = typeof payload?.line === "number" && Number.isFinite(payload.line) && payload.line > 0 ? payload.line : null;
    const program = typeof payload?.program === "string" ? payload.program : "";
    // Oracle prints the SOURCE line where a frame name would go, and the agent keeps
    // that text in its own `source` field so it can never be mistaken for a name. A
    // frame the agent could name wins; otherwise the source line still tells the
    // reader more than an em dash.
    const source = typeof payload?.source === "string" ? payload.source : "";
    return { index: position, program: program || source, line, payload };
  });
});

const frames = computed<StackFrame[]>(() => (snapshotFrames.value.length > 0 ? snapshotFrames.value : parseBacktrace(store.backtrace)));

async function selectFrame(frame: StackFrame) {
  if (!frame.payload && store.status?.frameMappingState !== undefined) return;
  if (!store.hasSession || frame.index === store.currentFrame) return;
  try {
    await store.selectFrame(frame.index);
  } catch {
    // `store.error` carries the failure for the toolbar.
  }
}

/** Whether a frame runs in an object other than the debug target, so its source can be viewed. */
function canViewFrameSource(frame: StackFrame): boolean {
  if (!store.hasSession || store.terminated || !frame.payload) return false;
  if (frame.payload.sourceState !== undefined) return currentSourceRef(frame) !== null;
  if (!(frame.payload.program ?? "").trim()) return false;
  return !frameBelongsToTarget(frame.payload, store.target);
}

function currentSourceRef(frame: StackFrame) {
  const payload = frame.payload;
  const source = payload?.sourceRef;
  if (store.busy || store.recoveryRequired || store.publicSnapshot?.state !== "paused" || payload?.sourceState !== "resolved" || !source || !source.id || source.sourceRevision <= 0 || source.stopRevision !== store.publicSnapshot.stopRevision || source.nativeFrameId !== payload.nativeFrameId)
    return null;
  return source;
}

/**
 * 「查看该帧源码」：把该帧所在对象的源码读到调试源码区（只读展示，不挂 gutter 断点 ——
 * 断点是按「当前调试对象 + 行号」下发的，把别的对象的源码挂上 gutter 只会把断点设到错误
 * 的对象上）。
 *
 * 帧名到字典对象的映射有三种形状（见 `frameSourceCandidates`），两段名还要区分「包成员」
 * 与「owner 限定的独立子程序」，所以按候选顺序逐个取源，取到第一份非空源码为止；全都不行
 * 时把**后端原话**放进视图里显示，而不是留一个空白（`store.frameSourceView.error`）。
 */
async function viewFrameSource(frame: StackFrame) {
  const payload = frame.payload;
  if (payload?.sourceState !== undefined) {
    const source = currentSourceRef(frame);
    if (!source) return;
    store.showFrameSource({ frameIndex: frame.index, program: payload.program || source.name || "", line: frame.line, owner: source.owner ?? "", name: source.name ?? "", source: source.source, error: null });
    return;
  }
  const connectionId = store.connectionId;
  const database = store.database;
  const fallbackOwner = (store.target?.schema || database || "").trim();
  const program = (payload?.program ?? "").trim();
  loadError.value = null;
  if (!payload || !program || !connectionId || !database) {
    loadError.value = t("plDebug.frameSource.unavailable");
    return;
  }
  const candidates = frameSourceCandidates(payload, fallbackOwner);
  if (candidates.length === 0) {
    loadError.value = t("plDebug.frameSource.unavailable");
    return;
  }
  loadingFrame.value = frame.index;
  try {
    let lastError: string | null = null;
    for (const candidate of candidates) {
      const owner = candidate.owner || fallbackOwner;
      try {
        const { source } = await loadPlDebugObjectSource(api.getObjectSource, connectionId, database, owner, candidate.name, candidate.objectType);
        if (source.source?.trim()) {
          store.showFrameSource({ frameIndex: frame.index, program, line: frame.line, owner, name: candidate.name, source: source.source, error: null });
          return;
        }
      } catch (caught) {
        lastError = String(caught);
      }
    }
    // Nothing loaded: keep the frame as the subject so the banner still says which
    // frame failed, and show the backend's own text where the source would be.
    store.showFrameSource({ frameIndex: frame.index, program, line: frame.line, owner: fallbackOwner, name: program, source: "", error: lastError ?? t("plDebug.frameSource.unavailable") });
  } finally {
    loadingFrame.value = null;
  }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-auto">
    <ul v-if="frames.length > 0" class="min-h-0">
      <li v-for="frame in frames" :key="`${frame.index}-${frame.program}-${frame.line ?? 0}`" class="flex items-center">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
          :class="frame.index === store.currentFrame ? 'bg-accent font-medium' : ''"
          :disabled="!frame.payload && store.status?.frameMappingState !== undefined"
          @click="selectFrame(frame)"
        >
          <span class="font-mono text-muted-foreground">#{{ frame.index }}</span>
          <span class="truncate font-mono">{{ frame.program || "—" }}</span>
          <span class="ml-auto shrink-0 font-mono text-muted-foreground">{{ t("plDebug.stack.line", { line: frame.line ?? "?" }) }}</span>
        </button>
        <Button v-if="canViewFrameSource(frame)" variant="ghost" size="sm" class="mr-1 h-6 w-6 shrink-0 p-0" :disabled="loadingFrame === frame.index" :title="t('plDebug.frameSource.view')" @click="viewFrameSource(frame)">
          <FileCode class="h-3.5 w-3.5" />
        </Button>
      </li>
    </ul>
    <p v-else class="p-2 text-xs text-muted-foreground">{{ t("plDebug.stack.empty") }}</p>
    <p v-if="loadError" class="border-t px-2 py-1 text-xs text-destructive">{{ loadError }}</p>
    <p v-if="store.stackError" class="border-t px-2 py-1 text-xs text-destructive">{{ store.stackError }}</p>
    <details v-if="store.backtrace" class="mt-1 border-t px-2 py-1 text-xs">
      <summary class="cursor-pointer text-muted-foreground">{{ t("plDebug.stack.backtrace") }}</summary>
      <pre class="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{{ store.backtrace }}</pre>
    </details>
  </div>
</template>

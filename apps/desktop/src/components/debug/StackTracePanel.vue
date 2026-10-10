<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { usePlDebugStore } from "@/stores/plDebugStore";

interface StackFrame {
  /** Frame number DBMS_DEBUG uses, `#0` being the innermost frame. */
  index: number;
  program: string;
  line: number | null;
}

const { t } = useI18n();
const store = usePlDebugStore();

/**
 * DBMS_DEBUG backtrace listings vary by server ("#0 PKG.PROC line 12",
 * "PKG.PROC at line 12", …), so the parser keeps every line that names a frame
 * or a line number and reads the program name out of it.
 */
function parseBacktrace(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
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
    });
  }
  return frames;
}

/**
 * A structured frame list is preferred when the snapshot carries one: the
 * backend may add `frames` next to the raw backtrace text.
 */
const snapshotFrames = computed<StackFrame[]>(() => {
  const raw = (store.status as { frames?: unknown } | null)?.frames;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, position) => {
    const frame = (entry ?? {}) as { index?: unknown; program?: unknown; line?: unknown; source?: unknown };
    const index = typeof frame.index === "number" && Number.isFinite(frame.index) ? frame.index : position;
    const line = typeof frame.line === "number" && Number.isFinite(frame.line) ? frame.line : null;
    const program = typeof frame.program === "string" ? frame.program : "";
    // Oracle prints the SOURCE line where a frame name would go, and the agent keeps
    // that text in its own `source` field so it can never be mistaken for a name. A
    // frame the agent could name wins; otherwise the source line still tells the
    // reader more than an em dash.
    const source = typeof frame.source === "string" ? frame.source : "";
    return { index, program: program || source, line };
  });
});

const frames = computed<StackFrame[]>(() => (snapshotFrames.value.length > 0 ? snapshotFrames.value : parseBacktrace(store.backtrace)));

async function selectFrame(frame: StackFrame) {
  if (!store.hasSession || frame.index === store.currentFrame) return;
  try {
    await store.selectFrame(frame.index);
  } catch {
    // `store.error` carries the failure for the toolbar.
  }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-auto">
    <ul v-if="frames.length > 0" class="min-h-0">
      <li v-for="frame in frames" :key="`${frame.index}-${frame.program}-${frame.line ?? 0}`">
        <button type="button" class="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-accent" :class="frame.index === store.currentFrame ? 'bg-accent font-medium' : ''" @click="selectFrame(frame)">
          <span class="font-mono text-muted-foreground">#{{ frame.index }}</span>
          <span class="truncate font-mono">{{ frame.program || "—" }}</span>
          <span class="ml-auto shrink-0 font-mono text-muted-foreground">{{ t("plDebug.stack.line", { line: frame.line ?? "?" }) }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="p-2 text-xs text-muted-foreground">{{ t("plDebug.stack.empty") }}</p>
    <details v-if="store.backtrace" class="mt-1 border-t px-2 py-1 text-xs">
      <summary class="cursor-pointer text-muted-foreground">{{ t("plDebug.stack.backtrace") }}</summary>
      <pre class="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{{ store.backtrace }}</pre>
    </details>
  </div>
</template>

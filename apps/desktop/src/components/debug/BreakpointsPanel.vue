<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Ban, Power, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlDebugStore, type PlDebugBreakpointLocals } from "@/stores/plDebugStore";
import type { PlDebugBreakpoint } from "@/lib/backend/pl-debug-tauri";

/**
 * One table row. Actions are keyed by line because the store keeps enablement,
 * the ignore count and the condition in `breakpointLocals`, keyed by line.
 */
interface BreakpointRow {
  breakpoint: PlDebugBreakpoint | null;
  native: boolean;
  key: string;
  line: number;
  name: string;
  enabled: boolean;
  ignoreCount: number;
  ignoreDraft?: string;
  condition: string;
  /** Note the user attached to the line; shown when a resume stops on it. */
  message: string;
  /** Reload warning the agent attached to the stored breakpoint, if any. */
  warning: string | null;
}

const { t } = useI18n();
const store = usePlDebugStore();
const busyLine = ref<number | null>(null);
const rowError = ref<string | null>(null);
const ruleDrafts = ref<Record<string, Partial<Record<"ignoreCount" | "condition" | "message", string>>>>({});

const targetLabel = computed(() => {
  const target = store.target;
  if (!target) return "";
  if (target.packageName && target.objectName) return `${target.packageName}.${target.objectName}`;
  return target.objectName ?? "";
});

function localsFor(line: number): PlDebugBreakpointLocals {
  const stored = store.breakpointLocals[line];
  return {
    enabled: stored?.enabled !== false,
    ignoreCount: typeof stored?.ignoreCount === "number" && stored.ignoreCount > 0 ? Math.trunc(stored.ignoreCount) : 0,
    condition: typeof stored?.condition === "string" ? stored.condition : "",
    hits: typeof stored?.hits === "number" ? stored.hits : 0,
    message: typeof stored?.message === "string" ? stored.message : "",
  };
}

function warningOf(breakpoint: object): string | null {
  const warning = (breakpoint as { warning?: unknown }).warning;
  return typeof warning === "string" && warning.trim() !== "" ? warning : null;
}

const rows = computed<BreakpointRow[]>(() => {
  const live = store.breakpoints.map((breakpoint) => {
    const locals = localsFor(breakpoint.line ?? 0);
    const key = `set-${breakpoint.registrationId ?? breakpoint.breakpointNumber ?? `${breakpoint.name ?? ""}:${breakpoint.line ?? 0}`}`;
    const draft = ruleDrafts.value[key];
    return {
      breakpoint,
      native: breakpoint.owned !== undefined,
      key,
      line: breakpoint.line ?? 0,
      name: breakpoint.name ?? breakpoint.owner ?? targetLabel.value,
      enabled: breakpoint.owned !== undefined ? breakpoint.localActive !== false : breakpoint.enabled !== false,
      ignoreCount: typeof breakpoint.ignoreCount === "number" ? breakpoint.ignoreCount : locals.ignoreCount,
      ignoreDraft: draft?.ignoreCount,
      condition: draft?.condition ?? (typeof breakpoint.condition === "string" ? breakpoint.condition : locals.condition),
      message: draft?.message ?? (typeof breakpoint.message === "string" ? breakpoint.message : locals.message),
      warning: warningOf(breakpoint),
    };
  });
  // Disabled breakpoints are deleted server-side, so only the store's kept
  // locals can render them (greyed out, with their condition and ignore count).
  const disabled = store.disabledBreakpointLines
    .filter((line) => !live.some((row) => row.line === line))
    .map((line) => {
      const locals = localsFor(line);
      return {
        breakpoint: null,
        native: false,
        key: `disabled-${line}`,
        line,
        name: targetLabel.value,
        enabled: false,
        ignoreCount: locals.ignoreCount,
        condition: locals.condition,
        message: locals.message,
        warning: null,
      };
    });
  return [...live, ...disabled].sort((left, right) => left.line - right.line);
});

async function run(line: number, action: () => Promise<unknown> | unknown) {
  busyLine.value = line;
  rowError.value = null;
  try {
    await action();
  } catch (caught) {
    rowError.value = String(caught);
  } finally {
    busyLine.value = null;
  }
}

function toggleEnabled(row: BreakpointRow) {
  if (row.native && row.breakpoint) return run(row.line, () => store.setOwnedBreakpointEnabled(row.breakpoint!, !row.enabled));
  return run(row.line, () => store.setBreakpointEnabled(row.line, !row.enabled));
}

/** 取消: an explicit removal, which also forgets the line's condition and count. */
function remove(row: BreakpointRow) {
  if (row.native && row.breakpoint) return run(row.line, () => store.deleteOwnedBreakpoint(row.breakpoint!));
  return run(row.line, async () => {
    if (row.enabled) {
      await store.toggleBreakpoint(row.line);
      return;
    }
    // A disabled line has nothing server-side to remove: restoring it first is
    // what lets `toggleBreakpoint` drop both the breakpoint and its locals.
    await store.setBreakpointEnabled(row.line, true);
    await store.toggleBreakpoint(row.line);
  });
}

function onIgnoreCountChange(row: BreakpointRow, event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  const parsed = raw.trim() === "" ? 0 : Number(raw);
  if (row.native && row.breakpoint) return changeNativeRules(row, { ignoreCount: parsed }, { ignoreCount: raw });
  store.setBreakpointIgnoreCount(row.line, Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0);
}

function onConditionChange(row: BreakpointRow, event: Event) {
  if (row.native && row.breakpoint) {
    const condition = (event.target as HTMLInputElement).value;
    return changeNativeRules(row, { condition }, { condition });
  }
  store.setBreakpointCondition(row.line, (event.target as HTMLInputElement).value.trim());
}

/** The breakpoint's own note: printed in the debug console when the line is hit. */
function onMessageChange(row: BreakpointRow, event: Event) {
  if (row.native && row.breakpoint) {
    const message = (event.target as HTMLInputElement).value;
    return changeNativeRules(row, { message }, { message });
  }
  store.setBreakpointMessage(row.line, (event.target as HTMLInputElement).value.trim());
}

function rulesDisabled(row: BreakpointRow) {
  return busyLine.value === row.line || store.busy || (row.native && (row.breakpoint?.owned !== true || store.status?.breakpointRulesOwner !== "agent" || store.publicSnapshot?.state !== "paused" || store.recoveryRequired));
}

function changeNativeRules(row: BreakpointRow, patch: Parameters<typeof store.updateOwnedBreakpointRules>[1], draft: Partial<Record<"ignoreCount" | "condition" | "message", string>>) {
  ruleDrafts.value[row.key] = { ...ruleDrafts.value[row.key], ...draft };
  return run(row.line, async () => {
    await store.updateOwnedBreakpointRules(row.breakpoint!, patch);
    const current = ruleDrafts.value[row.key];
    for (const field of Object.keys(draft) as Array<keyof typeof draft>) {
      if (current && current[field] === draft[field]) delete current[field];
    }
    if (current && Object.keys(current).length === 0) delete ruleDrafts.value[row.key];
  });
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full min-w-[720px] table-fixed text-xs">
        <colgroup>
          <col class="w-[24%]" />
          <col class="w-16" />
          <col class="w-24" />
          <col class="w-[28%]" />
          <col />
          <col class="w-20" />
        </colgroup>
        <thead class="sticky top-0 bg-background">
          <tr class="text-left text-muted-foreground">
            <th class="px-2 py-1 font-normal">{{ t("plDebug.breakpoints.object") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.breakpoints.line") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.breakpoints.ignoreCount") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.breakpoints.condition") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.breakpoints.message") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.breakpoints.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" class="border-t" :class="row.enabled ? (row.warning ? 'bg-amber-50/60 dark:bg-amber-950/20' : '') : 'text-muted-foreground opacity-60'">
            <td class="whitespace-pre-wrap break-all px-2 py-1 align-top font-mono">
              {{ row.name || "—" }}
              <span v-if="!row.enabled" class="ml-1 rounded bg-muted px-1 text-[10px] uppercase">{{ t("plDebug.breakpoints.disabled") }}</span>
              <p v-if="row.warning" class="mt-0.5 flex items-start gap-1 font-sans text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" />
                <span class="whitespace-pre-wrap break-all">WARN {{ row.warning }}</span>
              </p>
            </td>
            <td class="px-2 py-1 align-top font-mono">{{ row.line || "—" }}</td>
            <td class="px-2 py-1 align-top">
              <Input
                class="h-6 text-xs"
                type="number"
                min="0"
                :model-value="row.ignoreDraft ?? (row.ignoreCount > 0 ? row.ignoreCount : '')"
                :aria-label="`${t('plDebug.breakpoints.ignoreCount')} · ${row.name} · ${row.line}`"
                :placeholder="t('plDebug.breakpoints.ignoreCountPlaceholder')"
                :disabled="rulesDisabled(row)"
                @change="onIgnoreCountChange(row, $event)"
              />
            </td>
            <td class="px-2 py-1 align-top">
              <Input
                class="h-6 text-xs"
                :model-value="row.condition"
                :title="row.condition"
                :aria-label="`${t('plDebug.breakpoints.condition')} · ${row.name} · ${row.line}`"
                :placeholder="t('plDebug.breakpoints.conditionPlaceholder')"
                :disabled="rulesDisabled(row)"
                @change="onConditionChange(row, $event)"
              />
            </td>
            <td class="px-2 py-1 align-top">
              <Input class="h-6 text-xs" :model-value="row.message" :title="row.message" :aria-label="`${t('plDebug.breakpoints.message')} · ${row.name} · ${row.line}`" :placeholder="t('plDebug.breakpoints.messagePlaceholder')" :disabled="rulesDisabled(row)" @change="onMessageChange(row, $event)" />
            </td>
            <td class="px-2 py-1 align-top">
              <div class="flex items-center">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-6 w-6 p-0"
                  :disabled="busyLine === row.line || store.busy || store.recoveryRequired || !store.hasSession || (row.native && (row.breakpoint?.owned !== true || store.publicSnapshot?.state !== 'paused'))"
                  :title="row.enabled ? t('plDebug.breakpoints.disable') : t('plDebug.breakpoints.enable')"
                  @click="toggleEnabled(row)"
                >
                  <Ban v-if="row.enabled" class="h-3.5 w-3.5" />
                  <Power v-else class="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-6 w-6 p-0"
                  :disabled="busyLine === row.line || store.busy || store.recoveryRequired || !store.hasSession || (row.native && (row.breakpoint?.owned !== true || store.publicSnapshot?.state !== 'paused'))"
                  :title="t('plDebug.breakpoints.remove')"
                  @click="remove(row)"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </Button>
              </div>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="6" class="px-2 py-3 text-center text-muted-foreground">
              {{ t("plDebug.breakpoints.empty") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="rowError" class="border-t px-2 py-1 text-xs text-destructive">{{ t("plDebug.breakpoints.actionFailed", { error: rowError }) }}</p>
  </div>
</template>

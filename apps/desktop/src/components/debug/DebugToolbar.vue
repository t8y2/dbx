<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, FastForward, Loader2, Play, Redo2, RefreshCcw, Square, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePlDebugStore } from "@/stores/plDebugStore";

const emit = defineEmits<{ restart: [] }>();

const { t } = useI18n();
const store = usePlDebugStore();
const exceptionSwitchId = "pl-debug-exception-breakpoint";

const stateLabel = computed(() => {
  if (store.terminated) return t("plDebug.state.finished");
  if (store.busy) return t("plDebug.state.running");
  return t("plDebug.state.paused");
});

/** The agent reports an exception stop on the status snapshot. */
const stoppedOnException = computed(() => (store.status as { stoppedOnException?: boolean } | null)?.stoppedOnException === true);

/** Restart replays the launch dialog, which needs a named routine to re-resolve. */
const canRestart = computed(() => store.hasSession && !store.busy && store.connectionId !== null && store.database !== null && !!store.target?.objectName && store.target.objectType.toUpperCase() !== "ANONYMOUS");

async function toggleExceptionBreakpoint(enabled: boolean) {
  try {
    await store.setExceptionBreakpoint(enabled);
  } catch {
    // `store.error` already renders the failure next to the state label.
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1 border-b px-2 py-1">
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.resume')" @click="store.resume()">
      <Loader2 v-if="store.busy" class="h-4 w-4 animate-spin" />
      <Play v-else class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.runToCompletion')" @click="store.resumeIgnoreBreakpoints()">
      <FastForward class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.stepOver')" @click="store.stepOver()">
      <Redo2 class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.stepIn')" @click="store.stepIn()">
      <ArrowDownToLine class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.stepOut')" @click="store.stepOut()">
      <ArrowUpFromLine class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="!store.hasSession" :title="t('plDebug.toolbar.abort')" @click="store.abort()">
      <Square class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="!store.hasSession || store.busy" :title="t('plDebug.toolbar.close')" @click="store.close()">
      <X class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="!canRestart" :title="t('plDebug.toolbar.restart')" @click="emit('restart')">
      <RefreshCcw class="h-4 w-4" />
    </Button>
    <div class="ml-1 flex items-center gap-1.5">
      <Switch :id="exceptionSwitchId" size="sm" :disabled="store.busy || !store.hasSession" :model-value="store.exceptionBreakpoint" @update:model-value="toggleExceptionBreakpoint" />
      <label :for="exceptionSwitchId" class="cursor-pointer text-xs text-muted-foreground">{{ t("plDebug.toolbar.exceptionBreakpoint") }}</label>
    </div>
    <span class="mx-2 text-xs text-muted-foreground">{{ stateLabel }}</span>
    <span v-if="store.currentProgram" class="text-xs text-muted-foreground">
      {{ store.currentProgram }}<template v-if="store.currentLine"> : {{ store.currentLine }}</template>
    </span>
    <span v-if="stoppedOnException" class="flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
      <AlertTriangle class="h-3.5 w-3.5" />
      {{ t("plDebug.state.stoppedOnException") }}
    </span>
    <span v-if="store.error" class="ml-auto truncate text-xs text-destructive" :title="store.error">
      {{ store.error }}
    </span>
  </div>
</template>

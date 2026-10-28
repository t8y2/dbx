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
const controlsDisabled = computed(() => store.busy || store.terminated || !store.hasSession || store.recoveryRequired || store.publicSnapshot?.state !== "paused");

const stateLabel = computed(() => {
  if (store.recoveryRequired || !store.publicSnapshot || store.publicSnapshot.state === "unknown" || (store.lastReceipt?.state === "unknown" && store.pendingOperations[store.lastReceipt.operationId])) return t("plDebug.state.unknown");
  if (store.terminated) return t("plDebug.state.finished");
  if (store.busy || store.publicSnapshot.state === "running") return t("plDebug.state.running");
  return t("plDebug.state.paused");
});

async function runControl(action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    /* The store retains the original error and recovery identity. */
  }
}

/** The agent reports an exception stop on the status snapshot. */
const stoppedOnException = computed(() => store.publicSnapshot?.state === "paused" && !store.recoveryRequired && store.status?.stoppedOnException === true);

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
    <Button variant="ghost" size="sm" :disabled="controlsDisabled" :title="t('plDebug.toolbar.resume')" @click="runControl(store.resume)">
      <Loader2 v-if="store.busy" class="h-4 w-4 animate-spin" />
      <Play v-else class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="controlsDisabled" :title="t('plDebug.toolbar.runToCompletion')" @click="runControl(store.resumeIgnoreBreakpoints)">
      <FastForward class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="controlsDisabled" :title="t('plDebug.toolbar.stepOver')" @click="runControl(store.stepOver)">
      <Redo2 class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="controlsDisabled" :title="t('plDebug.toolbar.stepIn')" @click="runControl(store.stepIn)">
      <ArrowDownToLine class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="controlsDisabled" :title="t('plDebug.toolbar.stepOut')" @click="runControl(store.stepOut)">
      <ArrowUpFromLine class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="!store.hasSession" :title="t('plDebug.toolbar.abort')" @click="runControl(store.abort)">
      <Square class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.closeBusy || (!store.sessionRef && !store.pendingStart)" :title="t('plDebug.toolbar.close')" @click="runControl(store.close)">
      <Loader2 v-if="store.closeBusy" class="h-4 w-4 animate-spin" />
      <X v-else class="h-4 w-4" />
    </Button>
    <Button v-if="store.recoveryRequired" variant="outline" size="sm" @click="runControl(store.recover)">{{ t("plDebug.start.recover") }}</Button>
    <Button v-if="store.terminated && store.canRestart" variant="secondary" size="sm" class="h-6 gap-1 px-2 text-xs" :title="t('plDebug.toolbar.restart')" @click="emit('restart')">
      <RefreshCcw class="h-3.5 w-3.5" />
      {{ t("plDebug.toolbar.restart") }}
    </Button>
    <Button v-else variant="ghost" size="sm" :disabled="!store.canRestart" :title="t('plDebug.toolbar.restart')" @click="emit('restart')">
      <RefreshCcw class="h-4 w-4" />
    </Button>
    <div class="ml-1 flex max-w-full flex-wrap items-center gap-1.5">
      <Switch
        :id="exceptionSwitchId"
        size="sm"
        :disabled="controlsDisabled || (!store.exceptionBreakpoint && !!store.exceptionBreakpointUnavailableReason)"
        :aria-describedby="store.exceptionBreakpointUnavailableReason ? `${exceptionSwitchId}-reason` : undefined"
        :model-value="store.exceptionBreakpoint"
        @update:model-value="toggleExceptionBreakpoint"
      />
      <label :for="exceptionSwitchId" class="cursor-pointer text-xs text-muted-foreground">{{ t("plDebug.toolbar.exceptionBreakpoint") }}</label>
      <span v-if="store.exceptionBreakpointUnavailableReason" :id="`${exceptionSwitchId}-reason`" class="text-xs text-muted-foreground" role="status">{{ store.exceptionBreakpointUnavailableReason }}</span>
    </div>
    <span class="mx-2 text-xs text-muted-foreground">{{ stateLabel }}</span>
    <span v-if="store.terminated && store.target" class="text-xs text-muted-foreground">{{ t("plDebug.toolbar.finishedHint") }}</span>
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

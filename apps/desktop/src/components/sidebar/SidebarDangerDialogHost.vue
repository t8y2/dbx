<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import { SidebarDangerConfirmDialog } from "./sidebarAsyncDialogs";
import { sidebarDangerRunningExecutionId } from "./sidebarTreeDialogState";
import { registerSidebarDangerDialogHost, type SidebarDangerDialogOption, type SidebarDangerDialogRequest } from "@/lib/sidebar/sidebarDangerDialog";

const { t } = useI18n();
const { toast } = useToast();
const sidebarDangerDialogRequest = ref<SidebarDangerDialogRequest | null>(null);
const sidebarDangerDialogOpen = ref(false);
const sidebarDangerDialogConfirming = ref(false);
const sidebarDangerDialogCancelling = ref(false);

function showSidebarDangerDialog(request: SidebarDangerDialogRequest) {
  if (sidebarDangerRunningExecutionId.value || sidebarDangerDialogConfirming.value || (sidebarDangerDialogOpen.value && sidebarDangerDialogRequest.value?.loading)) {
    toast(t("contextMenu.dangerOperationAlreadyRunning"), 4000);
    return;
  }
  sidebarDangerDialogRequest.value = request;
  sidebarDangerDialogConfirming.value = false;
  // Defense in depth: sidebarDangerDialogCancelling is a singleton shared
  // across every danger dialog. It should already settle on its own (see
  // confirmCancelWithRetryAndTimeout), but a fresh dialog must never inherit
  // a stuck "cancelling" state from a previous one.
  sidebarDangerDialogCancelling.value = false;
  sidebarDangerDialogOpen.value = true;
}

async function confirmSidebarDangerDialog() {
  const request = sidebarDangerDialogRequest.value;
  if (!request || sidebarDangerDialogConfirming.value) return;
  if (request.closeOnConfirm !== false) sidebarDangerDialogOpen.value = false;
  sidebarDangerDialogConfirming.value = true;
  let completed: void | boolean = undefined;
  try {
    completed = await request.confirm();
  } finally {
    // A danger operation that hit a client-observed timeout is kept alive
    // (still cancellable) rather than settled outright — sidebarDangerRunningExecutionId
    // stays populated in that case, so keep the dialog "loading" (Cancel
    // Query still live, manual dismiss blocked) instead of closing on a
    // stale timeout result. The watcher below finishes the job once the
    // execution actually settles.
    if (!sidebarDangerRunningExecutionId.value) {
      sidebarDangerDialogConfirming.value = false;
      if (completed !== false) sidebarDangerDialogOpen.value = false;
    }
  }
}

// Finishes closing a danger dialog left open past a client-observed timeout
// once the deferred execution is actually confirmed cancelled — see
// confirmSidebarDangerDialog above.
watch(sidebarDangerRunningExecutionId, (value) => {
  if (!value && sidebarDangerDialogConfirming.value) {
    sidebarDangerDialogConfirming.value = false;
    sidebarDangerDialogOpen.value = false;
  }
});

async function cancelSidebarDangerDialogRunning() {
  const request = sidebarDangerDialogRequest.value;
  if (!request?.cancelRunning || sidebarDangerDialogCancelling.value) return;
  sidebarDangerDialogCancelling.value = true;
  try {
    await request.cancelRunning();
  } catch (error: any) {
    // Current cancelRunning implementations already swallow their own
    // rejections; this is a defensive fallback so the user still gets
    // feedback if a future implementation throws instead.
    toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    sidebarDangerDialogCancelling.value = false;
  }
}

function updateSidebarDangerDialogOption(event: Event, optionOverride?: SidebarDangerDialogOption) {
  const option = optionOverride ?? sidebarDangerDialogRequest.value?.option;
  if (!option) return;
  option.checked = (event.target as HTMLInputElement).checked;
  void option.onChange?.(option.checked);
}

function updateSidebarDangerDialogTextInput(value: string | number) {
  const input = sidebarDangerDialogRequest.value?.textInput;
  if (!input) return;
  input.value = String(value);
  void input.onInput?.(input.value);
}

const unregister = registerSidebarDangerDialogHost(showSidebarDangerDialog);
onBeforeUnmount(unregister);
</script>

<template>
  <SidebarDangerConfirmDialog
    v-if="sidebarDangerDialogRequest"
    v-model:open="sidebarDangerDialogOpen"
    :title="sidebarDangerDialogRequest.title"
    :message="sidebarDangerDialogRequest.message"
    :sql="sidebarDangerDialogRequest.sql"
    :copy-sql="sidebarDangerDialogRequest.copySql"
    :details="sidebarDangerDialogRequest.details"
    :details-text="sidebarDangerDialogRequest.detailsText"
    :confirm-label="sidebarDangerDialogRequest.confirmLabel"
    :loading="sidebarDangerDialogConfirming || sidebarDangerDialogRequest.loading"
    :confirm-disabled="sidebarDangerDialogRequest.confirmDisabled"
    :close-on-confirm="false"
    :cancelable="!!sidebarDangerDialogRequest.cancelRunning"
    :cancel-running-loading="sidebarDangerDialogCancelling"
    @confirm="confirmSidebarDangerDialog"
    @cancel-running="cancelSidebarDangerDialogRunning"
  >
    <template #options>
      <div v-if="sidebarDangerDialogRequest.progress" class="mb-3 rounded-md border bg-muted/20 px-3 py-2.5">
        <div class="mb-1.5 flex items-center justify-between text-xs tabular-nums text-muted-foreground">
          <span>{{ sidebarDangerDialogRequest.progress.phase === "preparing" ? t("databaseEmpty.preparing", { database: sidebarDangerDialogRequest.target.database }) : "" }} {{ sidebarDangerDialogRequest.progress.completed }} / {{ sidebarDangerDialogRequest.progress.total }}</span>
          <span>{{ Math.round((sidebarDangerDialogRequest.progress.completed / sidebarDangerDialogRequest.progress.total) * 100) }}%</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-valuemin="0" :aria-valuemax="sidebarDangerDialogRequest.progress.total" :aria-valuenow="sidebarDangerDialogRequest.progress.completed">
          <div class="h-full bg-primary transition-[width] duration-200" :style="{ width: `${Math.round((sidebarDangerDialogRequest.progress.completed / sidebarDangerDialogRequest.progress.total) * 100)}%` }" />
        </div>
      </div>
      <div v-if="sidebarDangerDialogRequest.options?.length" class="mb-3 flex flex-wrap gap-2">
        <template v-for="(option, optionIndex) in sidebarDangerDialogRequest.options ?? []" :key="`danger-option-${optionIndex}`">
          <label class="flex items-start gap-2 rounded-md border px-3 py-2 text-sm" :class="[option.compact ? 'min-w-32 flex-1' : 'w-full', option.danger && option.checked ? 'border-destructive/50 bg-destructive/10' : 'bg-muted/20']" :title="option.compact ? option.hint : undefined">
            <input :checked="option.checked" :disabled="sidebarDangerDialogConfirming" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0" :class="option.danger ? 'accent-destructive' : 'accent-primary'" @change="updateSidebarDangerDialogOption($event, option)" />
            <span class="grid gap-0.5">
              <span class="font-medium" :class="option.danger && option.checked ? 'text-destructive' : 'text-foreground'">{{ option.label }}</span>
              <span v-if="!option.compact" class="text-xs leading-5 text-muted-foreground">{{ option.hint }}</span>
            </span>
          </label>
        </template>
      </div>
      <label v-if="sidebarDangerDialogRequest.option" class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input :checked="sidebarDangerDialogRequest.option.checked" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="updateSidebarDangerDialogOption" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ sidebarDangerDialogRequest.option.label }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ sidebarDangerDialogRequest.option.hint }}</span>
        </span>
      </label>
      <label v-if="sidebarDangerDialogRequest.textInput" class="mb-3 grid gap-1.5 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <span class="font-medium text-foreground">{{ sidebarDangerDialogRequest.textInput.label }}</span>
        <Input :model-value="sidebarDangerDialogRequest.textInput.value" :inputmode="sidebarDangerDialogRequest.textInput.inputMode" :placeholder="sidebarDangerDialogRequest.textInput.placeholder" @update:model-value="updateSidebarDangerDialogTextInput" />
      </label>
    </template>
  </SidebarDangerConfirmDialog>
</template>

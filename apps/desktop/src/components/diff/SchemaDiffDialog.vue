<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import SchemaDiffPanel from "@/components/diff/SchemaDiffPanel.vue";
import { ExternalLink, GitCompareArrows, Maximize2, Minimize2 } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import { setSchemaDiffDialogBusy } from "@/composables/useDialogSources";
import type { SchemaDiffTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillSelectedRoutines?: string[];
  prefillResultTab?: "tables" | "routines";
  sessionId?: string | null;
  initialState?: SchemaDiffTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: SchemaDiffTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof SchemaDiffPanel>>();
const panelBusy = ref(false);
const panelStep = ref<"config" | "compare" | "result" | "deploy-review">("config");

function handleBusyChange(busy: boolean) {
  panelBusy.value = busy;
  setSchemaDiffDialogBusy(busy);
}

/** Icon action in the dialog header, left of the maximize and close buttons. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state || panelBusy.value) return;
  open.value = false;
  useQueryStore().openSchemaDiff(state);
}

// Dialog size memory (width + height). The splitpanes ratio lives in the Panel.
const DIALOG_SIZE_KEY = "dbx-schema-diff-size";
const savedSize = JSON.parse(localStorage.getItem(DIALOG_SIZE_KEY) || "null");

const isMaximized = ref(false);

// Config step: always use default size 1100x820
// Result step: use saved size if exists
const dialogStyle = computed(() => {
  if (isMaximized.value) {
    return {
      width: "100%",
      height: "100%",
      maxWidth: "100%",
      maxHeight: "100%",
      borderRadius: "0",
    };
  }
  if (panelStep.value === "result") {
    return {
      width: savedSize?.width || "1100px",
      height: savedSize?.height || "820px",
      maxWidth: "calc(100vw - 2rem)",
      maxHeight: "calc(100vh - 2rem)",
    };
  }
  return {
    width: "1100px",
    height: "820px",
    maxWidth: "calc(100vw - 2rem)",
    maxHeight: "calc(100vh - 2rem)",
  };
});

function toggleMaximize() {
  isMaximized.value = !isMaximized.value;
}

let componentUnmounted = false;
let resizeObserver: ResizeObserver | null = null;
let saveTimeout: number | null = null;

function setupResizeObserver() {
  if (componentUnmounted) return;
  const el = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
  if (!el) return;

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(() => {
        localStorage.setItem(
          DIALOG_SIZE_KEY,
          JSON.stringify({
            width: `${width}px`,
            height: `${height}px`,
          }),
        );
      }, 500);
    }
  });

  resizeObserver.observe(el);
}

function teardownResizeObserver() {
  if (saveTimeout) clearTimeout(saveTimeout);
  resizeObserver?.disconnect();
  resizeObserver = null;
}

// Only enable resize observer in result step
watch(
  () => panelStep.value,
  (newStep) => {
    if (newStep === "result") {
      setTimeout(() => {
        if (!componentUnmounted) setupResizeObserver();
      }, 100);
    } else {
      teardownResizeObserver();
    }
  },
);

onBeforeUnmount(() => {
  componentUnmounted = true;
  teardownResizeObserver();
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :class="['flex flex-col overflow-hidden dbx-schema-diff-dialog', isMaximized ? 'dbx-dialog-maximized min-w-0' : 'min-w-[800px] resize']"
      :portal-class="isMaximized ? 'p-0' : undefined"
      :style="dialogStyle"
      @interact-outside.prevent
      @escape-key-down="(event: KeyboardEvent) => panelRef?.handleDialogEscape(event)"
    >
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" @click="toggleMaximize">
        <Maximize2 v-if="!isMaximized" class="w-4 h-4" />
        <Minimize2 v-else class="w-4 h-4" />
        <span class="sr-only">{{ isMaximized ? t("diff.restore") : t("diff.maximize") }}</span>
      </Button>
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-[72px] z-10" :disabled="panelBusy" :title="panelBusy ? t('workspace.runStateLockedHint') : t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="w-4 h-4" />
      </Button>

      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 pr-24">
          <GitCompareArrows class="w-4 h-4" />
          {{ t("diff.title") }}
        </DialogTitle>
      </DialogHeader>
      <SchemaDiffPanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-schema="props.prefillSchema"
        :prefill-selected-routines="props.prefillSelectedRoutines"
        :prefill-result-tab="props.prefillResultTab"
        :session-id="props.sessionId"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
        @busy-state-change="handleBusyChange"
        @step-change="(step) => (panelStep = step)"
      />
    </DialogContent>
  </Dialog>
</template>

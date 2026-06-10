<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import { Upload, Download, FolderPlus, RefreshCw, ChevronsLeft } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import ConnectionTree from "@/components/sidebar/ConnectionTree.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";

defineProps<{
  sidebarWidth: number;
  classicLayout?: boolean;
}>();

const emit = defineEmits<{
  import: [source: "dbx" | "navicat" | "dbeaver" | "datagrip"];
  export: [];
  startResize: [event: MouseEvent];
  collapse: [];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();
const connectionTreeRef = ref<InstanceType<typeof ConnectionTree>>();
const importSourceItems = computed(() => [
  { value: "dbx", label: t("sidebar.importDbx") },
  { value: "navicat", label: t("sidebar.importNavicat") },
  { value: "dbeaver", label: t("sidebar.importDbeaver") },
  { value: "datagrip", label: t("sidebar.importDatagrip") },
]);

async function refreshTree() {
  try {
    await connectionStore.refreshAllTree();
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function createNewGroup() {
  void connectionTreeRef.value?.createNewGroup();
}

function focusSearch(): boolean {
  return connectionTreeRef.value?.focusSearch() ?? false;
}

defineExpose({ focusSearch });
</script>

<template>
  <div class="h-full shrink-0 relative select-none" :class="classicLayout ? '' : 'rounded-md border border-border/80 bg-background'" :style="{ width: sidebarWidth + 'px' }">
    <div class="h-full flex flex-col overflow-hidden">
      <div class="flex items-center gap-px px-3 text-xs font-medium text-muted-foreground border-b bg-muted/20" :class="classicLayout ? 'h-9' : 'h-10'">
        <span class="flex self-stretch items-center truncate" data-tauri-drag-region>{{ t("sidebar.connections") }}</span>
        <span class="flex-1 self-stretch" data-tauri-drag-region />
        <Tooltip>
          <TooltipTrigger as-child>
            <span class="inline-flex">
              <LightDropdown
                model-value=""
                :items="importSourceItems"
                :aria-label="t('sidebar.import')"
                :trigger-icon="Download"
                trigger-class="inline-flex h-6 w-5 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-0"
                trigger-icon-class="h-4 w-4"
                content-class="w-44"
                :show-trigger-label="false"
                :show-chevron="false"
                :highlight-selected="false"
                check-position="none"
                align="end"
                @update:model-value="(source) => emit('import', source as 'dbx' | 'navicat' | 'dbeaver' | 'datagrip')"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ t("sidebar.import") }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('export')">
              <Upload class="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("sidebar.export") }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="createNewGroup">
              <FolderPlus class="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("connectionGroup.createGroup") }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="refreshTree">
              <RefreshCw class="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("contextMenu.refreshChildren") }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-6 w-6" @click="emit('collapse')">
              <ChevronsLeft class="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("sidebar.collapse") }}</TooltipContent>
        </Tooltip>
      </div>
      <div class="flex-1 min-h-0">
        <ConnectionTree ref="connectionTreeRef" />
      </div>
    </div>
    <div class="panel-resize-handle panel-resize-handle--right" @mousedown="emit('startResize', $event)" />
  </div>
</template>

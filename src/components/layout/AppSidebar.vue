<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Upload, Download } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import ConnectionTree from "@/components/sidebar/ConnectionTree.vue";

defineProps<{
  sidebarWidth: number;
}>();

const emit = defineEmits<{
  import: [];
  export: [];
  startResize: [event: MouseEvent];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="h-full shrink-0 relative select-none" :style="{ width: sidebarWidth + 'px' }">
    <div class="h-full flex flex-col overflow-hidden">
      <div class="h-9 flex items-center px-3 text-xs font-medium text-muted-foreground border-b bg-muted/20">
        {{ t('sidebar.connections') }}
        <span class="flex-1" />
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('import')">
              <Upload class="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('sidebar.import') }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('export')">
              <Download class="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('sidebar.export') }}</TooltipContent>
        </Tooltip>
      </div>
      <div class="flex-1 overflow-y-auto">
        <ConnectionTree />
      </div>
    </div>
    <div class="panel-resize-handle panel-resize-handle--right" @mousedown="emit('startResize', $event)" />
  </div>
</template>

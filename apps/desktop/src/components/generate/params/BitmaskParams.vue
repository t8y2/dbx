<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { ColumnGenerateConfig, GeneratorParams } from "@/lib/dataGrid/dataGenerate";
import { bitColumnShape, generateValue } from "@/lib/dataGrid/dataGenerate";

const props = defineProps<{ params: GeneratorParams; config: ColumnGenerateConfig }>();

const { t } = useI18n();

const shape = computed(() => bitColumnShape(props.config.dataType));
const previewKey = ref(0);
const preview = computed(() => {
  void previewKey.value;
  return String(generateValue(props.config.columnName, props.config.dataType, "bitmask", 0, props.params));
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <code class="font-mono">{{ config.dataType }}</code>
        <span v-if="shape" class="text-muted-foreground ml-auto">{{ shape.width }} bit{{ shape.varying ? "+" : "" }}</span>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">{{ t("dataGenerate.preview") }}</span>
        <span :key="previewKey" class="font-mono text-sm break-all">{{ preview }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto shrink-0" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
  </div>
</template>

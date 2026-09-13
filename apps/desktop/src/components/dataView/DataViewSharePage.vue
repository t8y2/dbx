<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2 } from "@lucide/vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import DataViewRunner from "@/components/dataView/DataViewRunner.vue";
import * as api from "@/lib/backend/api";
import type { DataView } from "@/types/dataView";

const props = defineProps<{ viewId: string }>();

const { t } = useI18n();
const view = ref<DataView | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    view.value = await api.loadDataView(props.viewId);
    if (!view.value) error.value = t("dataView.title");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
    <TooltipProvider :delay-duration="300">
      <div v-if="loading" class="flex flex-1 items-center justify-center">
        <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
      <div v-else-if="error" class="flex flex-1 items-center justify-center text-sm text-destructive">{{ error }}</div>
      <DataViewRunner v-else-if="view" :view="view" embedded />
    </TooltipProvider>
  </div>
</template>

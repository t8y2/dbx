<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCcw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { usePlDebugStore } from "@/stores/plDebugStore";

const { t } = useI18n();
const store = usePlDebugStore();
const outputScroll = ref<HTMLElement | null>(null);

watch(
  () => store.output,
  async () => {
    await nextTick();
    outputScroll.value?.scrollTo({ top: outputScroll.value.scrollHeight });
  },
);
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex justify-end border-b px-1 py-0.5">
      <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="store.busy || !store.hasSession" :title="t('plDebug.output.refresh')" @click="store.refreshLog()">
        <RefreshCcw class="h-3.5 w-3.5" />
      </Button>
    </div>
    <div ref="outputScroll" class="min-h-0 flex-1 overflow-auto p-2">
      <pre v-if="store.output" class="whitespace-pre-wrap break-all font-mono text-xs">{{ store.output }}</pre>
      <p v-else class="text-xs text-muted-foreground">{{ t("plDebug.output.empty") }}</p>
    </div>
  </div>
</template>

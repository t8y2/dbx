<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { mqGetBrokerConfig } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import type { KafkaBrokerConfig } from "@/types/mq";

const props = defineProps<{ connectionId: string; brokerId: number | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const result = ref<KafkaBrokerConfig>();
const unsupported = computed(() => result.value?.configSupported === false);
const filter = ref("");
const error = ref("");
const refresh = ref(0);
const visible = computed(() => {
  const query = filter.value.trim().toLowerCase();
  return Object.entries(result.value?.configs ?? {})
    .filter(([key]) => key.toLowerCase().includes(query))
    .sort(([a], [b]) => a.localeCompare(b));
});

watch(
  () => [props.connectionId, props.brokerId] as const,
  () => {
    filter.value = "";
  },
  { flush: "sync" },
);
watch(
  () => [props.connectionId, props.brokerId, refresh.value] as const,
  async ([connectionId, brokerId], _, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    result.value = undefined;
    error.value = "";
    if (brokerId === null) return;
    try {
      const response = await mqGetBrokerConfig(connectionId, brokerId);
      if (active) result.value = response;
    } catch (cause) {
      if (!active) return;
      const message = formatError(cause);
      error.value = message === "Agent RPC error (-1): Unknown method: mq_get_broker_config" ? t("mqBroker.configurationDriverUnsupported") : message;
    }
  },
  { immediate: true, flush: "sync" },
);
</script>

<template>
  <Dialog
    :open="brokerId !== null"
    @update:open="
      (open) => {
        if (!open) emit('close');
      }
    "
  >
    <DialogContent class="flex max-h-[85dvh] flex-col sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ t("mqBroker.configuration") }}</DialogTitle>
        <DialogDescription>{{ t("mqBroker.nodeId") }}: {{ brokerId }}</DialogDescription>
      </DialogHeader>
      <div class="flex items-center gap-2">
        <Input v-model="filter" :placeholder="t('mqBroker.searchConfigurations')" :aria-label="t('mqBroker.searchConfigurations')" :disabled="unsupported" />
        <Button variant="outline" size="icon" :title="t('common.refresh')" :aria-label="t('common.refresh')" :disabled="!result && !error" @click="refresh++"><RefreshCw class="h-4 w-4" /></Button>
      </div>
      <p v-if="error" role="alert" class="break-words text-sm text-destructive">{{ error }}</p>
      <p v-else-if="!result" role="status" class="text-sm text-muted-foreground">{{ t("common.loading") }}</p>
      <div v-else-if="unsupported" role="status" class="space-y-1 break-words text-sm text-muted-foreground">
        <p>{{ t("mqBroker.configurationUnsupported") }}</p>
        <p v-if="result.unsupportedReason" class="text-xs">{{ result.unsupportedReason }}</p>
      </div>
      <p v-else-if="!visible.length" class="text-sm text-muted-foreground">{{ t("mqBroker.noConfigurations") }}</p>
      <div v-else class="min-h-0 overflow-auto">
        <table class="w-full table-fixed text-left text-xs">
          <thead class="sticky top-0 bg-background">
            <tr class="border-b">
              <th class="w-[44%] p-2">{{ t("mqBroker.configName") }}</th>
              <th class="w-[34%] p-2">{{ t("mqBroker.configValue") }}</th>
              <th class="p-2">{{ t("mqBroker.configSource") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[name, config] in visible" :key="name" class="border-b align-top">
              <td class="break-all p-2 font-mono">{{ name }}</td>
              <td class="break-all p-2 font-mono">{{ config.isSensitive ? "••••" : (config.value ?? "—") }}</td>
              <td class="break-all p-2">{{ config.source }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DialogContent>
  </Dialog>
</template>

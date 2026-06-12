<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import type { KafkaBrokerInfo } from "@/types/database";

const props = defineProps<{ connectionId: string }>();

const { t } = useI18n();
const loading = ref(false);
const brokers = ref<KafkaBrokerInfo[]>([]);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    brokers.value = await api.kafkaListBrokers(props.connectionId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    brokers.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.connectionId,
  () => void load(),
);
onMounted(() => void load());
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div class="min-w-0 flex-1 truncate text-sm font-medium">{{ t("kafka.brokersTitle") }}</div>
      <Badge variant="outline">{{ t("kafka.brokerCount", { count: brokers.length }) }}</Badge>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="load">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <div v-if="loading && brokers.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {{ t("kafka.loadingBrokers") }}
      </div>
      <div v-else-if="error" class="p-4 text-sm text-destructive">{{ error }}</div>
      <div v-else-if="brokers.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
        {{ t("kafka.brokersEmpty") }}
      </div>
      <table v-else class="w-full border-collapse text-sm">
        <thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur">
          <tr class="border-b text-left text-xs text-muted-foreground">
            <th class="px-3 py-2 font-medium">{{ t("kafka.brokerId") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.brokerHost") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.brokerPort") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.brokerAddress") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="broker in brokers" :key="broker.id" class="border-b border-border/50 hover:bg-accent/40">
            <td class="px-3 py-2 font-mono text-xs">{{ broker.id }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ broker.host }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ broker.port }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ broker.address }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

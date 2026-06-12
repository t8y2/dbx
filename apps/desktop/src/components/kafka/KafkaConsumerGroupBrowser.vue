<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import type { KafkaConsumerGroupDetail, KafkaConsumerGroupPartitionLag } from "@/lib/api";

const props = defineProps<{ connectionId: string; groupId: string }>();

const { t } = useI18n();

const loading = ref(false);
const detail = ref<KafkaConsumerGroupDetail | null>(null);
const error = ref("");

function formatOffset(value?: number | null): string {
  if (value == null) return "-";
  return String(value);
}

function formatLag(value?: number | null): string {
  if (value == null) return "-";
  return String(value);
}

function stateVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = state.toLowerCase();
  if (normalized === "stable") return "default";
  if (normalized === "empty" || normalized === "dead") return "secondary";
  if (normalized.includes("error") || normalized.includes("fail")) return "destructive";
  return "outline";
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    detail.value = await api.kafkaDescribeConsumerGroup(props.connectionId, props.groupId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

const partitions = ref<KafkaConsumerGroupPartitionLag[]>([]);

watch(
  () => detail.value,
  (value) => {
    partitions.value = value?.partitions
      ? [...value.partitions].sort((left, right) => {
          const topicCompare = left.topic.localeCompare(right.topic);
          if (topicCompare !== 0) return topicCompare;
          return left.partition - right.partition;
        })
      : [];
  },
  { immediate: true },
);

watch(
  () => [props.connectionId, props.groupId],
  () => {
    detail.value = null;
    void load();
  },
);

onMounted(() => void load());
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">{{ groupId }}</div>
        <div v-if="detail" class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge :variant="stateVariant(detail.state)">{{ detail.state }}</Badge>
          <Badge v-if="detail.protocolType" variant="outline">{{ detail.protocolType }}</Badge>
          <Badge v-if="detail.memberCount != null" variant="outline">{{ t("kafka.memberCount", { count: detail.memberCount }) }}</Badge>
        </div>
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="load">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <div v-if="loading && !detail" class="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {{ t("kafka.loadingConsumerGroup") }}
      </div>
      <div v-else-if="error" class="p-4 text-sm text-destructive">{{ error }}</div>
      <div v-else-if="partitions.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
        {{ t("kafka.consumerGroupEmpty") }}
      </div>
      <table v-else class="w-full border-collapse text-sm">
        <thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur">
          <tr class="border-b text-left text-xs text-muted-foreground">
            <th class="px-3 py-2 font-medium">{{ t("kafka.lagTopic") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.partition") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.committedOffset") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.endOffset") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.lag") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in partitions" :key="`${row.topic}-${row.partition}`" class="border-b border-border/50 hover:bg-accent/40">
            <td class="px-3 py-2 font-mono text-xs">{{ row.topic }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ row.partition }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ formatOffset(row.committedOffset) }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ formatOffset(row.endOffset) }}</td>
            <td class="px-3 py-2 font-mono text-xs" :class="{ 'text-destructive': (row.lag ?? 0) > 0 }">{{ formatLag(row.lag) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MqttSavedTopic, MqttTopicNode } from "@/types/mqtt";
import { ChevronRight, ChevronDown, Pencil, Power, Trash2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

interface Props {
  node: MqttTopicNode;
  depth: number;
  selectedTopic: string;
  subscribedTopics: [string, string][];
  savedTopics: MqttSavedTopic[];
  filter?: string;
}

const props = defineProps<Props>();
const { t } = useI18n();
const emit = defineEmits<{
  select: [topic: string];
  toggleEnabled: [config: MqttSavedTopic];
  edit: [config: MqttSavedTopic];
  delete: [config: MqttSavedTopic];
}>();

const expanded = ref(props.depth < 2);
const savedConfig = computed(() => props.savedTopics.find((config) => config.topic === props.node.fullPath));
const active = computed(() => props.subscribedTopics.some(([topic]) => topic === props.node.fullPath));
const visible = computed(() => {
  const filter = props.filter?.trim().toLowerCase();
  if (!filter) return true;
  const matches = (node: MqttTopicNode): boolean => node.fullPath.toLowerCase().includes(filter) || (node.children ?? []).some(matches);
  return matches(props.node);
});

function toggle() {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div v-if="visible">
    <div
      class="group flex min-h-8 items-center gap-1 border-b border-border/50 py-1 pr-1 text-[13px] transition-colors"
      :class="selectedTopic === node.fullPath ? 'border-l-2 border-l-primary bg-primary/10 pl-1 text-primary' : 'border-l-2 border-l-transparent pl-1 text-foreground/90 hover:bg-muted/60'"
      :style="{ paddingLeft: `${depth * 14 + 4}px` }"
    >
      <button v-if="node.children?.length" type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted" @click.stop="toggle">
        <ChevronRight v-if="!expanded" class="h-3.5 w-3.5" />
        <ChevronDown v-else class="h-3.5 w-3.5" />
      </button>
      <span v-else class="w-5 shrink-0" />

      <button type="button" class="min-w-0 flex-1 truncate text-left font-mono font-medium" :title="node.fullPath" @click="node.isLeaf ? emit('select', node.fullPath) : toggle()">{{ node.name }}<span v-if="!node.isLeaf" class="text-muted-foreground/70">/</span></button>

      <template v-if="savedConfig">
        <span class="shrink-0 rounded border px-1 py-0.5 text-[10px] text-muted-foreground">QoS {{ savedConfig.qos === "atmostonce" ? 0 : savedConfig.qos === "atleastonce" ? 1 : 2 }}</span>
        <span v-if="savedConfig.noLocal" class="shrink-0 rounded border border-blue-400/40 px-1 py-0.5 text-[10px] text-blue-600 dark:text-blue-400" :title="t('connection.mqttNoLocalMqtt5Only')">NL</span>
        <span class="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{{ active ? t("connection.mqttSubscriptionStatusActive") : savedConfig.enabled ? t("connection.mqttSubscriptionStatusPending") : t("connection.mqttSubscriptionStatusDisabled") }}</span>
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          :title="active ? t('connection.mqttSubscriptionDisable') : t('connection.mqttSubscriptionEnable')"
          @click.stop="emit('toggleEnabled', savedConfig)"
        >
          <Power class="h-3.5 w-3.5" :class="active ? 'text-emerald-600 dark:text-emerald-400' : ''" />
        </button>
        <button type="button" class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :title="t('connection.mqttSubscriptionEdit')" @click.stop="emit('edit', savedConfig)">
          <Pencil class="h-3.5 w-3.5" />
        </button>
        <button type="button" class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive" :title="t('connection.mqttSubscriptionDelete')" @click.stop="emit('delete', savedConfig)">
          <Trash2 class="h-3.5 w-3.5" />
        </button>
      </template>
    </div>

    <TopicTreeNode
      v-if="expanded"
      v-for="child in node.children"
      :key="child.fullPath"
      :node="child"
      :depth="depth + 1"
      :selected-topic="selectedTopic"
      :subscribed-topics="subscribedTopics"
      :saved-topics="savedTopics"
      :filter="filter"
      @select="emit('select', $event)"
      @toggle-enabled="emit('toggleEnabled', $event)"
      @edit="emit('edit', $event)"
      @delete="emit('delete', $event)"
    />
  </div>
</template>

<script lang="ts">
export default { name: "TopicTreeNode" };
</script>

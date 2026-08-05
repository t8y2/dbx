<script setup lang="ts">
import type { MqttTopicNode } from "@/types/mqtt";
import { ChevronRight, ChevronDown, Trash2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

interface Props {
  node: MqttTopicNode;
  depth: number;
  selectedTopic: string;
  subscribedTopics: [string, string][];
}

const props = defineProps<Props>();
const { t } = useI18n();
const emit = defineEmits<{
  select: [topic: string];
  subscribe: [topic: string];
  unsubscribe: [topics: string[]];
}>();

const expanded = ref(props.depth < 2);

function isSubscribed(topic: string): boolean {
  return props.subscribedTopics.some(([t]) => t === topic);
}

function collectSubscribedTopics(node: MqttTopicNode): string[] {
  const topics = node.isLeaf && isSubscribed(node.fullPath) ? [node.fullPath] : [];
  for (const child of node.children ?? []) {
    topics.push(...collectSubscribedTopics(child));
  }
  return topics;
}

const topicsToUnsubscribe = computed(() => collectSubscribedTopics(props.node));
const unsubscribeLabel = computed(() => (topicsToUnsubscribe.value.length === 1 ? t("connection.mqttUnsubscribeTopic", { topic: topicsToUnsubscribe.value[0] }) : t("connection.mqttUnsubscribeGroup", { count: topicsToUnsubscribe.value.length })));

function toggle() {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div>
    <div
      class="flex items-center gap-1 py-0.5 pl-2 pr-1 rounded cursor-pointer text-xs group border-l-2 border-transparent"
      :class="selectedTopic === node.fullPath ? 'bg-primary/25 text-foreground font-semibold border-l-primary shadow-sm ring-1 ring-primary/20' : 'hover:bg-muted/70 text-muted-foreground'"
      :style="{ paddingLeft: `${depth * 12 + 4}px` }"
      @click="node.isLeaf ? emit('select', node.fullPath) : toggle()"
    >
      <!-- Expand/collapse toggle -->
      <button v-if="node.children?.length" class="shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground" @click.stop="toggle">
        <ChevronRight v-if="!expanded" class="h-3 w-3" />
        <ChevronDown v-else class="h-3 w-3" />
      </button>
      <span v-else class="w-4 shrink-0" />

      <!-- Topic name -->
      <span class="truncate flex-1 font-mono" :class="selectedTopic === node.fullPath ? 'text-primary' : node.isLeaf ? 'font-medium text-blue-600 dark:text-blue-400' : ''">
        {{ node.name }}
      </span>

      <!-- 分组节点可一次取消其下全部订阅 -->
      <button
        v-if="topicsToUnsubscribe.length"
        type="button"
        class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-500 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 focus:opacity-100"
        :title="unsubscribeLabel"
        :aria-label="unsubscribeLabel"
        @click.stop="emit('unsubscribe', topicsToUnsubscribe)"
      >
        <Trash2 class="h-3 w-3" />
      </button>
    </div>

    <!-- Children -->
    <TopicTreeNode
      v-if="expanded"
      v-for="child in node.children"
      :key="child.fullPath"
      :node="child"
      :depth="depth + 1"
      :selected-topic="selectedTopic"
      :subscribed-topics="subscribedTopics"
      @select="emit('select', $event)"
      @subscribe="emit('subscribe', $event)"
      @unsubscribe="emit('unsubscribe', $event)"
    />
  </div>
</template>

<script lang="ts">
// Recursive component needs explicit name in non-setup script block
export default { name: "TopicTreeNode" };
</script>

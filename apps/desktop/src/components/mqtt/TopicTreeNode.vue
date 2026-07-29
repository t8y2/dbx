<script setup lang="ts">
import type { MqttTopicNode } from "@/types/mqtt";
import { ChevronRight, ChevronDown } from "@lucide/vue";
import { ref } from "vue";

interface Props {
  node: MqttTopicNode;
  depth: number;
  selectedTopic: string;
  subscribedTopics: [string, string][];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  select: [topic: string];
  subscribe: [topic: string];
  unsubscribe: [topic: string];
}>();

const expanded = ref(props.depth < 2);

function isSubscribed(topic: string): boolean {
  return props.subscribedTopics.some(([t]) => t === topic);
}

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

      <!-- Subscribe/unsubscribe button (for leaf topics) -->
      <button
        v-if="node.isLeaf"
        class="shrink-0 opacity-0 group-hover:opacity-100 text-[10px] px-1 py-0.5 rounded hover:bg-accent transition-opacity"
        :class="isSubscribed(node.fullPath) ? 'text-red-500' : 'text-green-600'"
        @click.stop="isSubscribed(node.fullPath) ? emit('unsubscribe', node.fullPath) : emit('subscribe', node.fullPath)"
      >
        {{ isSubscribed(node.fullPath) ? "取消" : "订阅" }}
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

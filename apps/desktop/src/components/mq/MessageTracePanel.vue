<script setup lang="ts">
import type { MqSystemKind, TopicInfo } from "@/types/mq";
import MessageQueryPanel from "./MessageQueryPanel.vue";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  mqSystemKind?: MqSystemKind;
}

defineProps<Props>();
</script>

<template>
  <MessageQueryPanel trace-panel :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :topic="topic" :read-only="readOnly" :mq-system-kind="mqSystemKind" />
</template>

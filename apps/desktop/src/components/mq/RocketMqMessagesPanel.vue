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
  preferDlqTopic?: boolean;
}

withDefaults(defineProps<Props>(), {
  preferDlqTopic: false,
});
</script>

<template>
  <MessageQueryPanel embedded :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :topic="topic" :read-only="readOnly" :mq-system-kind="mqSystemKind" :prefer-dlq-topic="preferDlqTopic" />
</template>

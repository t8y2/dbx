<script setup lang="ts">
import { ref } from "vue";
import { mqttPublish } from "@/lib/backend/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

interface Props {
  connectionId: string;
  initialTopic?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  published: [];
}>();

const topic = ref(props.initialTopic || "");
const qos = ref<0 | 1 | 2>(0);
const retain = ref(false);
const payloadText = ref("");
const payloadBase64 = ref("");
const useBase64 = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);

const qosLabel = ["QoS 0 — 最多一次", "QoS 1 — 至少一次", "QoS 2 — 精确一次"];

async function publish() {
  if (!topic.value.trim()) {
    error.value = "Topic 不能为空";
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    await mqttPublish(props.connectionId, {
      topic: topic.value.trim(),
      payloadBase64: useBase64.value ? payloadBase64.value : "",
      payloadText: useBase64.value ? null : payloadText.value || "(empty)",
      qos: qos.value === 0 ? "atmostonce" : qos.value === 1 ? "atleastonce" : "exactlyonce",
      retain: retain.value,
    });
    emit("published");
    emit("close");
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="emit('close')">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>发布 MQTT 消息</DialogTitle>
      </DialogHeader>

      <div class="space-y-3 py-2">
        <!-- Topic -->
        <div class="space-y-1">
          <label class="text-xs font-medium">主题 (Topic)</label>
          <input v-model="topic" class="w-full h-8 px-2 text-sm rounded border bg-transparent" placeholder="例如 sensors/temperature" />
        </div>

        <!-- QoS -->
        <div class="space-y-1">
          <label class="text-xs font-medium">服务质量 (QoS)</label>
          <div class="flex gap-2">
            <Button v-for="(label, i) in qosLabel" :key="i" size="sm" :variant="qos === i ? 'default' : 'outline'" @click="qos = i as 0 | 1 | 2">
              {{ label }}
            </Button>
          </div>
        </div>

        <!-- Retain -->
        <div class="flex items-center gap-2">
          <input type="checkbox" :checked="retain" @change="retain = !retain" class="rounded" />
          <label class="text-xs">保留消息 (Retain)</label>
        </div>

        <!-- Payload mode toggle -->
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <label class="text-xs font-medium">消息内容 (Payload)</label>
            <button class="text-xs text-blue-600 underline" @click="useBase64 = !useBase64">
              {{ useBase64 ? "切换到文本" : "切换到 Base64" }}
            </button>
          </div>
          <textarea v-if="!useBase64" v-model="payloadText" class="w-full h-24 px-2 py-1 text-sm rounded border bg-transparent font-mono resize-none" placeholder="输入消息内容..." />
          <textarea v-else v-model="payloadBase64" class="w-full h-24 px-2 py-1 text-sm rounded border bg-transparent font-mono resize-none" placeholder="输入 Base64 编码的消息..." />
        </div>

        <!-- Error -->
        <div v-if="error" class="text-xs text-red-600">{{ error }}</div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="emit('close')">取消</Button>
        <Button size="sm" @click="publish" :disabled="loading">
          {{ loading ? "发布中..." : "发布" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Plus } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/api";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  open: boolean;
  connectionId: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  created: [topicName: string];
}>();

const { t } = useI18n();
const { toast } = useToast();

const name = ref("");
const partitions = ref(1);
const replicationFactor = ref(1);
const creating = ref(false);
const error = ref("");

function resetForm() {
  name.value = "";
  partitions.value = 1;
  replicationFactor.value = 1;
  error.value = "";
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) resetForm();
  },
);

async function createTopic() {
  const topicName = name.value.trim();
  if (!topicName) {
    error.value = t("kafka.topicNameRequired");
    return;
  }
  if (!Number.isFinite(partitions.value) || partitions.value < 1) {
    error.value = t("kafka.partitionsInvalid");
    return;
  }
  if (!Number.isFinite(replicationFactor.value) || replicationFactor.value < 1) {
    error.value = t("kafka.replicationFactorInvalid");
    return;
  }

  creating.value = true;
  error.value = "";
  try {
    await api.kafkaCreateTopic(props.connectionId, {
      name: topicName,
      partitions: partitions.value,
      replicationFactor: replicationFactor.value,
    });
    emit("update:open", false);
    emit("created", topicName);
    toast(t("kafka.topicCreated"), 2500);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t("kafka.createTopicTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3 py-2">
        <div class="grid grid-cols-4 items-center gap-3">
          <span class="text-right text-sm">{{ t("kafka.topicName") }}</span>
          <Input v-model="name" class="col-span-3" :placeholder="t('kafka.topicNamePlaceholder')" @keydown.enter.prevent="createTopic" />
        </div>
        <div class="grid grid-cols-4 items-center gap-3">
          <span class="text-right text-sm">{{ t("kafka.partitions") }}</span>
          <Input v-model.number="partitions" type="number" min="1" class="col-span-3" />
        </div>
        <div class="grid grid-cols-4 items-center gap-3">
          <span class="text-right text-sm">{{ t("kafka.replicationFactor") }}</span>
          <Input v-model.number="replicationFactor" type="number" min="1" class="col-span-3" />
        </div>
        <div v-if="error" class="text-sm text-destructive">{{ error }}</div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t("common.cancel") }}</Button>
        <Button :disabled="creating" @click="createTopic">
          <Loader2 v-if="creating" class="mr-2 h-4 w-4 animate-spin" />
          <Plus v-else class="mr-2 h-4 w-4" />
          {{ t("kafka.createTopic") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

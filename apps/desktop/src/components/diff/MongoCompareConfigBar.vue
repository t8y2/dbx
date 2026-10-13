<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { mongoCompareConfigSnapshot, useMongoCompareConfigs, type MongoCompareConfigSnapshot } from "@/composables/useMongoCompareConfigs";

const props = defineProps<{ snapshot: MongoCompareConfigSnapshot; disabled: boolean }>();
const emit = defineEmits<{ apply: [snapshot: MongoCompareConfigSnapshot] }>();
const { t } = useI18n();
const { configs, activeId, storageError, save, remove } = useMongoCompareConfigs();
const name = ref("");
const message = ref("");
const deleting = ref(false);
const active = computed(() => configs.value.find((item) => item.id === activeId.value));
const dirty = computed(() => !!active.value && (name.value.trim() !== active.value.name || JSON.stringify(props.snapshot) !== JSON.stringify(mongoCompareConfigSnapshot(active.value))));

function apply(id: unknown) {
  const config = configs.value.find((item) => item.id === String(id));
  if (!config || props.disabled) return;
  activeId.value = config.id;
  name.value = config.name;
  message.value = "";
  deleting.value = false;
  emit("apply", mongoCompareConfigSnapshot(config));
}
function saveConfig(asNew = false) {
  if (props.disabled) return;
  try {
    if (save(name.value, props.snapshot, asNew)) {
      name.value = configs.value.find((item) => item.id === activeId.value)?.name ?? name.value;
      message.value = t("mongoCompare.configSaved");
    }
  } catch {
    message.value = t("mongoCompare.configLimit");
  }
  deleting.value = false;
}
function deleteConfig() {
  if (props.disabled) return;
  if (remove()) {
    name.value = "";
    message.value = "";
  }
  deleting.value = false;
}
</script>

<template>
  <section class="space-y-2 border-b border-border pb-3" :aria-label="t('mongoCompare.configs')">
    <div class="flex flex-wrap items-center gap-2">
      <Select :model-value="activeId" :disabled="disabled" @update:model-value="apply">
        <SelectTrigger class="h-8 w-56 text-xs" :aria-label="t('mongoCompare.configs')"><SelectValue :placeholder="t('mongoCompare.configs')" /></SelectTrigger>
        <SelectContent
          ><SelectItem v-for="config in configs" :key="config.id" :value="config.id">{{ config.name }}</SelectItem></SelectContent
        >
      </Select>
      <Input v-model="name" :disabled="disabled" class="h-8 w-48 text-xs" :aria-label="t('mongoCompare.configName')" :placeholder="t('mongoCompare.configName')" @keydown.enter="saveConfig()" />
      <Button size="sm" variant="outline" :disabled="disabled || !name.trim()" @click="saveConfig()">{{ t("mongoCompare.configSave") }}</Button>
      <Button size="sm" variant="ghost" :disabled="disabled || !name.trim()" @click="saveConfig(true)">{{ t("mongoCompare.configSaveAs") }}</Button>
      <Button v-if="active" size="sm" variant="ghost" :disabled="disabled" @click="deleting = !deleting">{{ t("mongoCompare.configDelete") }}</Button>
      <span v-if="dirty" class="text-xs text-amber-800 dark:text-amber-200">{{ t("mongoCompare.configUnsaved") }}</span>
    </div>
    <div v-if="deleting" class="flex flex-wrap items-center gap-2 text-xs">
      <span>{{ t("mongoCompare.configDeleteConfirm", { name: active?.name }) }}</span>
      <Button size="sm" variant="destructive" :disabled="disabled" @click="deleteConfig">{{ t("mongoCompare.configDelete") }}</Button>
      <Button size="sm" variant="ghost" :disabled="disabled" @click="deleting = false">{{ t("mongoCompare.cancel") }}</Button>
    </div>
    <p v-if="storageError" role="alert" class="text-xs text-destructive">{{ t("mongoCompare.configStorageError") }}</p>
    <p v-else-if="message" role="status" class="text-xs">{{ message }}</p>
  </section>
</template>

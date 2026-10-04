<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, FileDown, Plus, Trash2 } from "@lucide/vue";
import type { DataCompareConfig } from "@/composables/useDataCompareConfig";

const props = defineProps<{
  configs: DataCompareConfig[];
  activeConfigId: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:activeConfigId", id: string): void;
  (e: "create"): void;
  (e: "rename", id: string, name: string): void;
  (e: "delete", id: string): void;
  (e: "duplicate", id: string): void;
}>();

const { t } = useI18n();

const renameDialogOpen = ref(false);
const renameValue = ref("");
const renamingId = ref("");

const activeConfig = computed(() => props.configs.find((config) => config.id === props.activeConfigId) ?? null);

function onSelectChange(value: unknown) {
  emit("update:activeConfigId", String(value));
}

function startRename(config: DataCompareConfig) {
  renamingId.value = config.id;
  renameValue.value = config.name;
  renameDialogOpen.value = true;
}

function confirmRename() {
  if (renamingId.value && renameValue.value.trim()) {
    emit("rename", renamingId.value, renameValue.value.trim());
  }
  renameDialogOpen.value = false;
}
</script>

<template>
  <div class="flex items-center gap-2">
    <Select :model-value="activeConfigId" :disabled="disabled" @update:model-value="onSelectChange">
      <SelectTrigger class="h-8 min-w-[200px] text-xs" data-testid="data-compare-config-select">
        <SelectValue :placeholder="t('dataCompare.configSelect')" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="config in configs" :key="config.id" :value="config.id"> {{ config.name }} ({{ t("dataCompare.configTableCount", { count: config.selectedSourceTables.length }) }}) </SelectItem>
      </SelectContent>
    </Select>

    <Button variant="outline" size="icon" class="h-8 w-8" :disabled="disabled" :title="t('dataCompare.configNew')" @click="emit('create')">
      <Plus class="h-4 w-4" />
    </Button>

    <Button v-if="activeConfig" variant="outline" size="icon" class="h-8 w-8" :disabled="disabled" :title="t('dataCompare.configRename')" @click="startRename(activeConfig)">
      <Copy class="h-4 w-4" />
    </Button>

    <Button v-if="activeConfig" variant="outline" size="icon" class="h-8 w-8" :disabled="disabled" :title="t('dataCompare.configDuplicate')" @click="emit('duplicate', activeConfig.id)">
      <FileDown class="h-4 w-4" />
    </Button>

    <Button v-if="activeConfig" variant="outline" size="icon" class="h-8 w-8" :disabled="disabled" :title="t('dataCompare.configDelete')" @click="emit('delete', activeConfig.id)">
      <Trash2 class="h-4 w-4" />
    </Button>

    <Dialog v-model:open="renameDialogOpen">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t("dataCompare.configRename") }}</DialogTitle>
        </DialogHeader>
        <div class="py-4">
          <Label class="text-sm">{{ t("dataCompare.configName") }}</Label>
          <Input v-model="renameValue" class="mt-2" @keydown.enter="confirmRename" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="renameDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button @click="confirmRename">{{ t("common.save") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

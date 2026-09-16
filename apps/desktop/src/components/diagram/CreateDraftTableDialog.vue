<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DiagramLayer } from "@/types/diagram";

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  layers: DiagramLayer[];
  activeLayerId: string | null;
  existingNames: string[];
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "create", payload: { name: string; layerId: string | null; withDefaultId: boolean }): void;
}>();

const openModel = computed({
  get: () => props.open,
  set: (v: boolean) => emit("update:open", v),
});

const name = ref("");
const layerId = ref<string | "">("");
const withDefaultId = ref(true);
const error = ref("");

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = "";
      layerId.value = props.activeLayerId || "";
      withDefaultId.value = true;
      error.value = "";
    }
  },
);

function submit() {
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = t("diagram.tableNameRequired");
    return;
  }
  if (props.existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
    error.value = t("diagram.tableNameExists");
    return;
  }
  emit("create", { name: trimmed, layerId: layerId.value || null, withDefaultId: withDefaultId.value });
  openModel.value = false;
}
</script>

<template>
  <Dialog v-model:open="openModel">
    <DialogContent class="max-w-md gap-3">
      <DialogHeader>
        <DialogTitle>{{ t("diagram.createTable") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-3">
        <div class="space-y-1">
          <label class="text-xs text-muted-foreground">{{ t("diagram.tableName") }}</label>
          <Input v-model="name" class="h-8 text-xs" @keydown.enter="submit" />
        </div>
        <div class="space-y-1">
          <label class="text-xs text-muted-foreground">{{ t("diagram.assignLayer") }}</label>
          <select v-model="layerId" class="h-8 w-full rounded border border-border bg-background px-2 text-xs">
            <option value="">{{ t("diagram.noLayer") }}</option>
            <option v-for="layer in layers" :key="layer.id" :value="layer.id">{{ layer.name }}</option>
          </select>
        </div>
        <label class="flex items-center gap-2 text-xs">
          <input v-model="withDefaultId" type="checkbox" />
          {{ t("diagram.withDefaultIdPk") }}
        </label>
        <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" @click="openModel = false">{{ t("common.cancel") }}</Button>
        <Button type="button" size="sm" @click="submit">{{ t("diagram.create") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

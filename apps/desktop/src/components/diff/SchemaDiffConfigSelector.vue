<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Upload, Plus, Trash2, Copy, Pencil } from "@lucide/vue";
import type { SchemaDiffConfig } from "@/types/schemaDiff";

const props = defineProps<{
  configs: SchemaDiffConfig[];
  activeConfigId: string;
}>();

const emit = defineEmits<{
  (e: "update:activeConfigId", id: string): void;
  (e: "create", name: string): void;
  (e: "rename", id: string, name: string): void;
  (e: "delete", id: string): void;
  (e: "duplicate", id: string): void;
  (e: "export", config: SchemaDiffConfig): void;
  (e: "exportAll", configs: SchemaDiffConfig[]): void;
  (e: "import", jsonText: string): void;
}>();

const { t } = useI18n();

const renameDialogOpen = ref(false);
const renameValue = ref("");
const renamingId = ref("");

const importDialogOpen = ref(false);
const importValue = ref("");
const importError = ref("");

function onSelectChange(value: unknown) {
  emit("update:activeConfigId", String(value));
}

function startRename(config: SchemaDiffConfig) {
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

function handleCreate() {
  const baseName = t("schemaDiff.newConfigName");
  let name = baseName;
  let counter = 1;
  while (props.configs.some((c) => c.name === name)) {
    counter++;
    name = `${baseName} ${counter}`;
  }
  emit("create", name);
}

function handleImport() {
  importError.value = "";
  try {
    JSON.parse(importValue.value);
    emit("import", importValue.value);
    importDialogOpen.value = false;
    importValue.value = "";
  } catch {
    importError.value = t("schemaDiff.importInvalidJson");
  }
}

function downloadJson(data: string, filename: string) {
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function onExport() {
  const config = props.configs.find((c) => c.id === props.activeConfigId);
  if (config) {
    emit("export", config);
    downloadJson(JSON.stringify(config, null, 2), `dbx-schema-diff-${config.name}.json`);
  }
}

function onExportAll() {
  emit("exportAll", props.configs);
  downloadJson(JSON.stringify(props.configs, null, 2), "dbx-schema-diff-configs.json");
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    JSON.parse(text);
    emit("import", text);
    importDialogOpen.value = false;
  } catch {
    importError.value = t("schemaDiff.importInvalidJson");
  }
  input.value = "";
}

const activeConfig = computed(() => props.configs.find((c) => c.id === props.activeConfigId));
</script>

<template>
  <div class="flex items-center gap-2">
    <Select :model-value="activeConfigId" @update:model-value="onSelectChange">
      <SelectTrigger class="h-8 text-sm min-w-[180px]">
        <SelectValue :placeholder="t('schemaDiff.selectConfig')" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="config in configs" :key="config.id" :value="config.id">
          {{ config.name }}
        </SelectItem>
      </SelectContent>
    </Select>

    <Button variant="outline" size="icon" class="h-8 w-8" :title="t('schemaDiff.newConfig')" :aria-label="t('schemaDiff.newConfig')" data-testid="schema-diff-config-create" @click="handleCreate">
      <Plus class="h-4 w-4" />
    </Button>

    <Button v-if="activeConfig" variant="outline" size="icon" class="h-8 w-8" :title="t('schemaDiff.renameConfig')" :aria-label="t('schemaDiff.renameConfig')" data-testid="schema-diff-config-rename" @click="startRename(activeConfig)">
      <Pencil class="h-4 w-4" />
    </Button>

    <Button v-if="activeConfig" variant="outline" size="icon" class="h-8 w-8" :title="t('schemaDiff.duplicateConfig')" :aria-label="t('schemaDiff.duplicateConfig')" data-testid="schema-diff-config-duplicate" @click="emit('duplicate', activeConfig.id)">
      <Copy class="h-4 w-4" />
    </Button>

    <Button v-if="activeConfig && configs.length > 1" variant="outline" size="icon" class="h-8 w-8" :title="t('schemaDiff.deleteConfig')" :aria-label="t('schemaDiff.deleteConfig')" data-testid="schema-diff-config-delete" @click="activeConfig && emit('delete', activeConfig.id)">
      <Trash2 class="h-4 w-4" />
    </Button>

    <Button variant="outline" size="icon" class="h-8 w-8" :title="t('schemaDiff.exportConfig')" :aria-label="t('schemaDiff.exportConfig')" @click="onExport">
      <Upload class="h-4 w-4" />
    </Button>

    <Button variant="outline" size="icon" class="h-8 w-8" :title="t('schemaDiff.importConfig')" :aria-label="t('schemaDiff.importConfig')" @click="importDialogOpen = true">
      <Download class="h-4 w-4" />
    </Button>

    <Button variant="outline" size="icon" class="h-8 w-8" :title="t('schemaDiff.exportAllConfigs')" :aria-label="t('schemaDiff.exportAllConfigs')" @click="onExportAll">
      <Upload class="h-4 w-4" />
    </Button>

    <!-- Rename Dialog -->
    <Dialog v-model:open="renameDialogOpen">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t("schemaDiff.renameConfig") }}</DialogTitle>
        </DialogHeader>
        <div class="py-4">
          <Label class="text-sm">{{ t("schemaDiff.configName") }}</Label>
          <Input v-model="renameValue" class="mt-2" data-testid="schema-diff-config-rename-input" autofocus @keydown.enter="confirmRename" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="renameDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button data-testid="schema-diff-config-rename-save" @click="confirmRename">{{ t("common.save") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Import Dialog -->
    <Dialog v-model:open="importDialogOpen">
      <DialogContent class="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{{ t("schemaDiff.importConfig") }}</DialogTitle>
        </DialogHeader>
        <div class="py-4 space-y-4">
          <div>
            <Label class="text-sm">{{ t("schemaDiff.importFromFile") }}</Label>
            <Input type="file" accept=".json" class="mt-2" @change="onImportFile" />
          </div>
          <div>
            <Label class="text-sm">{{ t("schemaDiff.importFromText") }}</Label>
            <textarea v-model="importValue" class="mt-2 w-full min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm" :placeholder="t('schemaDiff.importPlaceholder')" />
          </div>
          <p v-if="importError" class="text-sm text-destructive">{{ importError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="importDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button @click="handleImport">{{ t("common.import") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

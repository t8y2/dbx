<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Edit3, FileJson, Lock, Plus, Search, Trash2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/common/utils";

interface BusinessTag {
  key: string;
  value: string;
  description: string;
  immutable: boolean;
}

interface TagFilter {
  search: string;
  showExpired: boolean;
  environment: string;
}

const props = defineProps<{
  tags: BusinessTag[];
  whitelist: string[];
}>();

const emit = defineEmits<{
  save: [tag: BusinessTag];
  delete: [key: string];
  import: [tags: BusinessTag[]];
  updateWhitelist: [keys: string[]];
}>();

const { t } = useI18n();

const filter = ref<TagFilter>({
  search: "",
  showExpired: false,
  environment: "",
});

const showAddDialog = ref(false);
const showImportDialog = ref(false);
const showWhitelistSection = ref(false);
const editingTag = ref<BusinessTag | null>(null);
const confirmDeleteKey = ref<string | null>(null);
const importData = ref("");
const importPreview = ref<BusinessTag[]>([]);
const whitelistInput = ref("");

const environments = ["", "development", "staging", "production"];

const filteredTags = computed(() => {
  return props.tags.filter((tag) => {
    if (filter.value.search) {
      const q = filter.value.search.toLowerCase();
      if (!tag.key.toLowerCase().includes(q) && !tag.value.toLowerCase().includes(q) && !tag.description.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });
});

function resetEditingTag() {
  editingTag.value = { key: "", value: "", description: "", immutable: false };
}

function openAddDialog() {
  resetEditingTag();
  showAddDialog.value = true;
}

function openEditDialog(tag: BusinessTag) {
  editingTag.value = { ...tag };
  showAddDialog.value = true;
}

function handleSave() {
  if (!editingTag.value) return;
  emit("save", { ...editingTag.value });
  showAddDialog.value = false;
  editingTag.value = null;
}

function handleDelete(key: string) {
  emit("delete", key);
  confirmDeleteKey.value = null;
}

function parseImport() {
  try {
    const parsed: BusinessTag[] = JSON.parse(importData.value);
    importPreview.value = parsed.filter((item): item is BusinessTag => typeof item.key === "string" && typeof item.value === "string" && typeof item.description === "string" && typeof item.immutable === "boolean");
  } catch {
    const lines = importData.value.split("\n").filter(Boolean);
    const parsed: BusinessTag[] = lines.map((line) => {
      const parts = line.split(",");
      return {
        key: parts[0]?.trim() ?? "",
        value: parts[1]?.trim() ?? "",
        description: parts[2]?.trim() ?? "",
        immutable: parts[3]?.trim() === "true",
      };
    });
    importPreview.value = parsed.filter((item) => item.key);
  }
}

function handleImport() {
  if (importPreview.value.length === 0) return;
  emit("import", importPreview.value);
  importPreview.value = [];
  importData.value = "";
  showImportDialog.value = false;
}

function addWhitelistKey() {
  const key = whitelistInput.value.trim();
  if (!key || props.whitelist.includes(key)) return;
  emit("updateWhitelist", [...props.whitelist, key]);
  whitelistInput.value = "";
}

function removeWhitelistKey(key: string) {
  emit(
    "updateWhitelist",
    props.whitelist.filter((k) => k !== key),
  );
}

function handleExport() {
  const blob = new Blob([JSON.stringify(props.tags, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tags.json";
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="tag-management-panel">
    <div class="panel-header">
      <h2 class="panel-title">{{ t("tag.management") }}</h2>
      <div class="panel-actions">
        <Button variant="outline" size="sm" @click="showImportDialog = true">
          <FileJson class="h-4 w-4" />
          {{ t("tag.importTags") }}
        </Button>
        <Button variant="outline" size="sm" @click="handleExport">
          <Download class="h-4 w-4" />
          {{ t("tag.exportTags") }}
        </Button>
        <Button size="sm" @click="openAddDialog">
          <Plus class="h-4 w-4" />
          {{ t("common.add") }}
        </Button>
      </div>
    </div>

    <div class="filter-bar">
      <div class="search-wrapper">
        <Search class="search-icon" />
        <Input v-model="filter.search" :placeholder="t('common.search')" />
      </div>
      <div class="filter-controls">
        <Select v-model="filter.environment">
          <SelectTrigger class="w-[160px]">
            <SelectValue :placeholder="t('tag.environment')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">
              {{ t("common.all") }}
            </SelectItem>
            <SelectItem v-for="env in environments.filter(Boolean)" :key="env" :value="env">
              {{ env }}
            </SelectItem>
          </SelectContent>
        </Select>
        <label class="expired-toggle">
          <Switch v-model="filter.showExpired" size="sm" />
          <span>{{ t("tag.expired") }}</span>
        </label>
      </div>
    </div>

    <div class="table-container">
      <table class="tag-table">
        <thead>
          <tr>
            <th>{{ t("tag.key") }}</th>
            <th>{{ t("tag.value") }}</th>
            <th>{{ t("tag.description") }}</th>
            <th>{{ t("tag.immutable") }}</th>
            <th class="actions-cell">{{ t("common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filteredTags.length === 0">
            <td colspan="5" class="empty-state">
              {{ t("tag.noTags") }}
            </td>
          </tr>
          <tr v-for="tag in filteredTags" :key="tag.key">
            <td class="cell-key">{{ tag.key }}</td>
            <td>{{ tag.value }}</td>
            <td class="cell-desc">{{ tag.description }}</td>
            <td>
              <Badge v-if="tag.immutable" variant="secondary" class="immutable-badge">
                <Lock class="h-3 w-3" />
                {{ t("tag.immutable") }}
              </Badge>
              <span v-else class="text-muted-foreground text-xs">—</span>
            </td>
            <td class="actions-cell">
              <div class="row-actions">
                <Button variant="ghost" size="icon-sm" @click="openEditDialog(tag)">
                  <Edit3 class="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" :disabled="tag.immutable" @click="confirmDeleteKey = tag.key">
                  <Trash2 class="h-4 w-4" />
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Separator class="my-2" />

    <div class="whitelist-section">
      <button class="whitelist-toggle" @click="showWhitelistSection = !showWhitelistSection">
        <span>{{ t("tag.whitelist") }}</span>
        <span class="whitelist-count">{{ props.whitelist.length }}</span>
        <svg :class="cn('chevron', showWhitelistSection && 'open')" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <div v-if="showWhitelistSection" class="whitelist-content">
        <div class="whitelist-chips">
          <span v-for="key in props.whitelist" :key="key" class="whitelist-chip">
            {{ key }}
            <button class="chip-remove" @click="removeWhitelistKey(key)">
              <X class="h-3 w-3" />
            </button>
          </span>
        </div>
        <div class="whitelist-add-row">
          <Input v-model="whitelistInput" :placeholder="t('tag.key')" @keydown.enter="addWhitelistKey" />
          <Button variant="outline" size="sm" @click="addWhitelistKey">
            {{ t("common.add") }}
          </Button>
        </div>
      </div>
    </div>
  </div>

  <Dialog v-model:open="showAddDialog">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>
          {{ editingTag?.key && !editingTag?.key.startsWith("_new") ? t("common.edit") : t("common.add") }}
          {{ t("tag.management") }}
        </DialogTitle>
      </DialogHeader>
      <div class="grid gap-4 py-4">
        <div class="form-field">
          <Label>{{ t("tag.key") }}</Label>
          <Input v-model="editingTag!.key" />
        </div>
        <div class="form-field">
          <Label>{{ t("tag.value") }}</Label>
          <Input v-model="editingTag!.value" />
        </div>
        <div class="form-field">
          <Label>{{ t("tag.description") }}</Label>
          <textarea v-model="editingTag!.description" class="desc-textarea" rows="3" />
        </div>
        <label class="immutable-field">
          <Switch v-model="editingTag!.immutable" size="sm" />
          <span>{{ t("tag.immutable") }}</span>
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showAddDialog = false">
          {{ t("common.cancel") }}
        </Button>
        <Button @click="handleSave">
          {{ t("common.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showImportDialog">
    <DialogContent class="sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle>
          {{ t("tag.batchImport") }}
        </DialogTitle>
      </DialogHeader>
      <div class="grid gap-4 py-4">
        <textarea v-model="importData" class="import-textarea" rows="6" :placeholder="t('tag.batchImport')" />
        <div v-if="importPreview.length > 0" class="import-preview">
          <p class="preview-count">{{ importPreview.length }} {{ t("common.rows") }}</p>
          <table class="preview-table">
            <thead>
              <tr>
                <th>{{ t("tag.key") }}</th>
                <th>{{ t("tag.value") }}</th>
                <th>{{ t("tag.description") }}</th>
                <th>{{ t("tag.immutable") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, idx) in importPreview.slice(0, 10)" :key="idx">
                <td>{{ item.key }}</td>
                <td>{{ item.value }}</td>
                <td>{{ item.description }}</td>
                <td>{{ item.immutable }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showImportDialog = false">
          {{ t("common.cancel") }}
        </Button>
        <Button variant="secondary" :disabled="!importData" @click="parseImport">
          {{ t("common.parse") }}
        </Button>
        <Button :disabled="importPreview.length === 0" @click="handleImport">
          {{ t("common.import") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog
    v-model:open="confirmDeleteKey !== null"
    @update:open="
      (v) => {
        if (!v) confirmDeleteKey = null;
      }
    "
  >
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>
          {{ t("common.confirm") }}
        </DialogTitle>
      </DialogHeader>
      <p class="py-4 text-sm">
        {{ t("tag.confirmDelete", { key: confirmDeleteKey }) }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="confirmDeleteKey = null">
          {{ t("common.cancel") }}
        </Button>
        <Button variant="destructive" @click="confirmDeleteKey && handleDelete(confirmDeleteKey)">
          {{ t("common.delete") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.tag-management-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.search-wrapper {
  position: relative;
  flex: 1;
  min-width: 200px;
}

.search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--muted-foreground);
  pointer-events: none;
}

.search-wrapper :deep(input) {
  padding-left: 32px;
}

.filter-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.expired-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.table-container {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.tag-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.tag-table th {
  text-align: left;
  padding: 10px 12px;
  font-weight: 500;
  color: var(--muted-foreground);
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  white-space: nowrap;
}

.tag-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.tag-table tr:last-child td {
  border-bottom: none;
}

.tag-table tbody tr:hover {
  background: var(--accent);
}

.empty-state {
  text-align: center;
  color: var(--muted-foreground);
  padding: 32px 12px !important;
}

.cell-key {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  font-weight: 500;
}

.cell-desc {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-foreground);
}

.actions-cell {
  width: 100px;
  text-align: right;
}

.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.immutable-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.whitelist-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.whitelist-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  padding: 4px 0;
  color: inherit;
}

.whitelist-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  background: var(--bg-secondary);
  padding: 0 6px;
}

.chevron {
  transition: transform 0.2s;
}

.chevron.open {
  transform: rotate(90deg);
}

.whitelist-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.whitelist-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.whitelist-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  font-size: 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}

.chip-remove {
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  color: var(--muted-foreground);
}

.whitelist-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.desc-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  outline: none;
}

.desc-textarea:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 2px var(--ring);
}

.immutable-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.import-textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  resize: vertical;
  outline: none;
}

.import-textarea:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 2px var(--ring);
}

.import-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-count {
  font-size: 13px;
  font-weight: 500;
  margin: 0;
}

.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.preview-table th {
  text-align: left;
  padding: 6px 8px;
  font-weight: 500;
  color: var(--muted-foreground);
  border-bottom: 1px solid var(--border);
}

.preview-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
</style>

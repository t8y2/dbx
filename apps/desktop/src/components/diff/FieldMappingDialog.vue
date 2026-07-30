<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Download, Upload, Check, X, Trash2 } from "@lucide/vue";
import FieldMappingPanel from "@/components/diff/FieldMappingPanel.vue";
import type { FieldMappingEntry } from "@/types/schemaDiff";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  open: boolean;
  mappings: FieldMappingEntry[];
  sourceDbType: string;
  targetDbType: string;
  sourceConnectionId?: string;
  sourceDatabase?: string;
  targetConnectionId?: string;
  targetDatabase?: string;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", value: FieldMappingEntry[]): void;
}>();

const { t } = useI18n();
const { toast } = useToast();

const editingMappings = ref<FieldMappingEntry[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);

// 打开时深拷贝当前映射为本地副本（单向数据流，取消不写回）
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      editingMappings.value = props.mappings.map((m) => ({ ...m }));
    }
  },
  { immediate: true },
);

function handleUpdateMappings(v: FieldMappingEntry[]) {
  editingMappings.value = v;
}

function handleExport() {
  const payload = {
    sourceDbType: props.sourceDbType,
    targetDbType: props.targetDbType,
    mappings: editingMappings.value,
  };
  const content = JSON.stringify(payload, null, 2);
  // Use File System Access API (modern Chromium) for a native Save As dialog,
  // fallback to Blob download for other browsers.
  if ("showSaveFilePicker" in window) {
    (window as any)
      .showSaveFilePicker({
        suggestedName: "field-mappings.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      })
      .then((handle: FileSystemFileHandle) => {
        return handle.createWritable().then((writable: FileSystemWritableFileStream) => {
          writable.write(content);
          return writable.close();
        });
      })
      .catch(() => {
        // User cancelled or API failed — fallback to Blob download
        fallbackDownload(content);
      });
  } else {
    fallbackDownload(content);
  }
}

function handleClear() {
  editingMappings.value = [];
}

function fallbackDownload(content: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "field-mappings.json";
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportClick() {
  fileInputRef.value?.click();
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result)) as any;

      // Support both new format { sourceDbType, targetDbType, mappings }
      // and legacy flat format FieldMappingEntry[]
      let mappings: any[];
      let fileSourceDbType: string | undefined;
      let fileTargetDbType: string | undefined;

      if (Array.isArray(parsed)) {
        mappings = parsed;
      } else if (parsed?.mappings && Array.isArray(parsed.mappings)) {
        mappings = parsed.mappings;
        fileSourceDbType = parsed.sourceDbType;
        fileTargetDbType = parsed.targetDbType;
      } else {
        throw new Error("invalid structure");
      }

      const normalized: FieldMappingEntry[] = mappings.map((item: any) => ({
        sourceType: String(item.sourceType ?? ""),
        targetType: String(item.targetType ?? ""),
        paramStrategy: item.paramStrategy === "strip" || item.paramStrategy === "custom" ? item.paramStrategy : "preserve",
        customParams: item.customParams ? String(item.customParams) : undefined,
      }));
      if (normalized.some((m) => !m.sourceType || !m.targetType)) {
        throw new Error("missing sourceType/targetType");
      }

      // Warn if exported source/target types differ from current
      if (fileSourceDbType && fileTargetDbType && (fileSourceDbType !== props.sourceDbType || fileTargetDbType !== props.targetDbType)) {
        toast(t("diff.fieldMapping.importTypeMismatch", { src: fileSourceDbType, tgt: fileTargetDbType }), 5000);
      }

      editingMappings.value = normalized;
      toast(t("diff.fieldMapping.importSuccess"), 2000);
    } catch {
      toast(t("diff.fieldMapping.importError"), 3000);
    } finally {
      input.value = "";
    }
  };
  reader.onerror = () => toast(t("diff.fieldMapping.importError"), 3000);
  reader.readAsText(file);
}

function handleDone() {
  emit(
    "save",
    editingMappings.value.map((m) => ({ ...m })),
  );
  emit("update:open", false);
}

function handleClose() {
  emit("update:open", false);
}
</script>

<template>
  <div v-if="open" class="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center" @click.self="handleClose">
    <div class="bg-card border rounded-lg shadow-lg w-[760px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-auto p-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-medium">{{ t("diff.fieldMapping.title") }}</h3>
        <Button variant="ghost" size="sm" @click="handleClose">
          <X class="w-3.5 h-3.5" />
        </Button>
      </div>

      <FieldMappingPanel
        :mappings="editingMappings"
        :source-db-type="sourceDbType"
        :target-db-type="targetDbType"
        :source-connection-id="sourceConnectionId"
        :source-database="sourceDatabase"
        :target-connection-id="targetConnectionId"
        :target-database="targetDatabase"
        @update:mappings="handleUpdateMappings"
      />

      <div class="flex items-center justify-between mt-4 pt-3 border-t">
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" @click="handleClear" :disabled="editingMappings.length === 0">
            <Trash2 class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.fieldMapping.clearMappings") }}
          </Button>
          <Button variant="outline" size="sm" @click="handleImportClick">
            <Upload class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.fieldMapping.import") }}
          </Button>
          <Button variant="outline" size="sm" @click="handleExport">
            <Download class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.fieldMapping.export") }}
          </Button>
        </div>
        <Button size="sm" @click="handleDone">
          <Check class="w-3.5 h-3.5 mr-1" />
          {{ t("diff.fieldMapping.done") }}
        </Button>
      </div>

      <input ref="fileInputRef" type="file" accept=".json,application/json" class="hidden" @change="onFileSelected" />
    </div>
  </div>
</template>

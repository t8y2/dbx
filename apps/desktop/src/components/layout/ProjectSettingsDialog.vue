<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import type { SqlProject } from "@/lib/backend/tauri";

const NONE_CONNECTION_VALUE = "__none__";

const props = defineProps<{
  project: SqlProject | null;
}>();

const emit = defineEmits<{
  save: [project: SqlProject];
}>();

const open = defineModel<boolean>("open", { default: false });

const { t } = useI18n();
const connectionStore = useConnectionStore();

const name = ref("");
const connectionId = ref<string>(NONE_CONNECTION_VALUE);
const defaultSchema = ref("");

const sqlConnections = computed(() => connectionStore.connections.filter((connection) => !["redis", "mongodb", "elasticsearch", "easysearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "consul", "mq", "nacos"].includes(connection.db_type)));

watch(
  open,
  (value) => {
    if (!value || !props.project) return;
    name.value = props.project.name;
    connectionId.value = props.project.connectionId || NONE_CONNECTION_VALUE;
    defaultSchema.value = props.project.defaultSchema || "";
  },
  { immediate: true },
);

function connectionLabel(id: string): string {
  return connectionStore.connections.find((connection) => connection.id === id)?.name || id;
}

function handleSave() {
  if (!props.project) return;
  emit("save", {
    ...props.project,
    name: name.value.trim() || props.project.name,
    connectionId: connectionId.value === NONE_CONNECTION_VALUE ? null : connectionId.value,
    defaultSchema: defaultSchema.value.trim() ? defaultSchema.value.trim() : null,
  });
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>{{ t("sqlFileTree.projectSettings") }}</DialogTitle>
        <DialogDescription class="truncate" :title="project?.rootPath">{{ project?.rootPath }}</DialogDescription>
      </DialogHeader>
      <div class="grid gap-3 py-2">
        <div class="grid gap-1.5">
          <Label class="text-[13px]">{{ t("sqlFileTree.projectName") }}</Label>
          <Input v-model="name" class="h-8 text-[13px]" :placeholder="t('sqlFileTree.projectName')" @keydown.enter.prevent="handleSave" />
        </div>
        <div class="grid gap-1.5">
          <Label class="text-[13px]">{{ t("sqlFileTree.boundConnection") }}</Label>
          <Select v-model="connectionId">
            <SelectTrigger class="h-8 w-full text-[13px]">
              <SelectValue :placeholder="t('sqlFileTree.noBoundConnection')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE_CONNECTION_VALUE">{{ t("sqlFileTree.noBoundConnection") }}</SelectItem>
              <SelectItem v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">{{ connectionLabel(connection.id) }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-[11px] text-muted-foreground">{{ t("sqlFileTree.boundConnectionHint") }}</p>
        </div>
        <div class="grid gap-1.5">
          <Label class="text-[13px]">{{ t("sqlFileTree.defaultSchema") }}</Label>
          <Input v-model="defaultSchema" class="h-8 text-[13px]" :placeholder="t('sqlFileTree.defaultSchemaPlaceholder')" @keydown.enter.prevent="handleSave" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button size="sm" @click="handleSave">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { installedConnectionAppLabels, loadInstalledConnectionGroups, type InstalledConnectionGroup, type InstalledConnectionSelection, type InstalledConnectionSource } from "@/lib/imports/installedConnections";

const props = defineProps<{ open: boolean; busy?: boolean; readFile: (source: InstalledConnectionSource["source"]) => Promise<InstalledConnectionGroup | null> }>();
const emit = defineEmits<{
  "update:open": [open: boolean];
  confirm: [selections: InstalledConnectionSelection[]];
}>();
const { t } = useI18n();
const groups = ref<InstalledConnectionGroup[]>([]);
const manualGroups = ref<InstalledConnectionGroup[]>([]);
const allGroups = computed(() => [...groups.value, ...manualGroups.value]);
const manualSource = ref<InstalledConnectionSource["source"]>("navicat");
const readingFile = ref(false);
const busy = computed(() => props.busy || readingFile.value);
const selected = ref(new Set<string>());
const collapsed = ref(new Set<string>());
const loading = ref(false);
const errors = ref<string[]>([]);
const rowKey = (group: InstalledConnectionGroup, id: string) => JSON.stringify([group.path, id]);
const apps = computed(() => {
  const result = new Map<string, { label: string; rows: { key: string; connection: InstalledConnectionGroup["preview"]["connections"][number] }[] }>();
  for (const group of allGroups.value) {
    const app = result.get(group.source) ?? { label: group.label, rows: [] };
    for (const connection of group.preview.connections) app.rows.push({ key: rowKey(group, connection.id), connection });
    result.set(group.source, app);
  }
  return [...result.values()];
});
const total = computed(() => apps.value.reduce((sum, app) => sum + app.rows.length, 0));

function toggle(key: string, checked: boolean) {
  const next = new Set(selected.value);
  if (checked) next.add(key);
  else next.delete(key);
  selected.value = next;
}

function toggleCollapsed(label: string) {
  const next = new Set(collapsed.value);
  if (!next.delete(label)) next.add(label);
  collapsed.value = next;
}

function selectAll(checked: boolean) {
  selected.value = checked ? new Set(apps.value.flatMap((app) => app.rows.map((row) => row.key))) : new Set();
}

function confirm() {
  if (loading.value || busy.value || !selected.value.size) return;
  emit(
    "confirm",
    allGroups.value.map((group) => ({ group, connectionIds: group.preview.connections.filter((connection) => selected.value.has(rowKey(group, connection.id))).map((connection) => connection.id) })).filter((selection) => selection.connectionIds.length),
  );
}

async function scan() {
  if (loading.value || busy.value) return;
  loading.value = true;
  errors.value = [];
  groups.value = [];
  selected.value = new Set();
  try {
    const result = await loadInstalledConnectionGroups();
    groups.value = result.groups;
    errors.value = result.errors;
  } catch (error) {
    errors.value = [String(error)];
  } finally {
    loading.value = false;
  }
}

async function addFile() {
  if (loading.value || busy.value) return;
  readingFile.value = true;
  try {
    const group = await props.readFile(manualSource.value);
    if (!group) return;
    if (!group.preview.connections.length) throw new Error(t("installedImport.fileEmpty"));
    manualGroups.value.push(group);
  } catch (error) {
    errors.value.push(error instanceof Error ? error.message : String(error));
  } finally {
    readingFile.value = false;
  }
}
onMounted(scan);
</script>

<template>
  <Dialog :open="open" @update:open="!busy && emit('update:open', $event)">
    <DialogContent class="sm:max-w-170">
      <DialogHeader
        ><DialogTitle>{{ t("installedImport.title") }}</DialogTitle></DialogHeader
      >
      <div class="flex items-center justify-between gap-4">
        <p class="text-sm font-medium">{{ t("installedImport.fromApps") }}</p>
        <Button variant="outline" size="sm" :disabled="loading || busy" @click="scan">{{ t("installedImport.rescan") }}</Button>
      </div>
      <p class="text-sm text-muted-foreground">{{ t("installedImport.directHint") }}</p>
      <p class="text-xs text-muted-foreground">DBeaver · DataGrip · Navicat · Redis Desktop Manager</p>
      <div class="flex flex-wrap items-center gap-2 rounded-md border p-3">
        <label for="manual-connection-source" class="text-sm">{{ t("installedImport.manualApp") }}</label>
        <select id="manual-connection-source" v-model="manualSource" :disabled="loading || busy" class="h-8 rounded-md border bg-background px-2 text-sm">
          <option v-for="(label, source) in installedConnectionAppLabels" :key="source" :value="source">{{ label }}</option>
        </select>
        <Button variant="outline" size="sm" :disabled="loading || busy" @click="addFile">{{ readingFile ? t("installedImport.readingFile") : t("installedImport.addFile") }}</Button>
      </div>
      <div v-if="errors.length" role="alert" class="text-sm text-destructive">
        <p v-for="error in errors" :key="error">{{ error }}</p>
      </div>
      <label v-if="total" class="flex items-center gap-2 text-sm">
        <input type="checkbox" :checked="selected.size === total" :indeterminate="selected.size > 0 && selected.size < total" :disabled="loading || busy" @change="selectAll(($event.target as HTMLInputElement).checked)" />
        {{ t("installedImport.selectAll") }} ({{ total }})
      </label>
      <div class="max-h-95 space-y-4 overflow-y-auto" aria-live="polite" :aria-busy="loading">
        <p v-if="loading" class="py-4 text-sm text-muted-foreground">{{ t("installedImport.scanning") }}</p>
        <p v-else-if="!total" class="py-4 text-sm text-muted-foreground">{{ t("installedImport.emptyConnections") }}</p>
        <section v-for="app in apps" :key="app.label" class="overflow-hidden rounded-md border">
          <h3 class="bg-muted/30 text-sm font-medium" :class="{ 'border-b': !collapsed.has(app.label) }">
            <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent" :aria-expanded="!collapsed.has(app.label)" @click="toggleCollapsed(app.label)">
              <ChevronRight class="size-4 shrink-0 transition-transform" :class="{ 'rotate-90': !collapsed.has(app.label) }" />
              {{ app.label }} ({{ app.rows.length }})
            </button>
          </h3>
          <label v-for="row in collapsed.has(app.label) ? [] : app.rows" :key="row.key" class="flex cursor-pointer items-center gap-3 border-b p-3 last:border-b-0 hover:bg-accent">
            <input type="checkbox" :checked="selected.has(row.key)" :disabled="busy" @change="toggle(row.key, ($event.target as HTMLInputElement).checked)" />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">{{ row.connection.name }}</span>
              <span class="block truncate text-xs text-muted-foreground"
                >{{ row.connection.db_type }} · {{ row.connection.host }}<template v-if="row.connection.port">:{{ row.connection.port }}</template
                ><template v-if="row.connection.database"> / {{ row.connection.database }}</template></span
              >
              <span v-if="row.connection.password" class="block text-xs text-muted-foreground">{{ t("installedImport.savedPassword") }}</span>
            </span>
          </label>
        </section>
      </div>
      <p class="text-xs text-muted-foreground">{{ t("installedImport.passwords") }}</p>
      <p v-if="allGroups.some((group) => group.label.includes('Wine'))" class="text-xs text-muted-foreground">{{ t("installedImport.winePasswordUpdate") }}</p>
      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('update:open', false)">{{ t("installedImport.cancel") }}</Button>
        <Button :disabled="loading || busy || !selected.size" @click="confirm">{{ busy ? t("installedImport.importing") : t("installedImport.importSelected") }} ({{ selected.size }})</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

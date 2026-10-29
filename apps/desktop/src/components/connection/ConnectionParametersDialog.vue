<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Search, Trash2, RotateCcw, Copy } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { uuid } from "@/lib/common/utils";
import { connectionParameterCatalog, connectionParameterSyntax, parameterDefinitionForKey, parameterValueError, type ConnectionParameterContext, type ConnectionParameterDefinition } from "@/lib/connection/connectionParameterCatalog";
import { parameterIsSecret, parseConnectionParameters, writeConnectionParameters, type ParameterEntry } from "@/lib/connection/connectionParameterDocument";

const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ modelValue?: string; context: ConnectionParameterContext; definitions?: ConnectionParameterDefinition[]; loading?: boolean; metadataError?: string }>();
const emit = defineEmits<{ apply: [value: string] }>();
const { t, locale } = useI18n();
const tr = (key: string, params: Record<string, unknown> = {}) => t(`connection.parameterEditor.${key}`, params);
const syntax = computed(() => connectionParameterSyntax(props.context));
const catalog = computed(() => {
  const definitions = [...connectionParameterCatalog(props.context)];
  for (const definition of props.definitions ?? []) {
    if (!parameterDefinitionForKey(definitions, definition.name)) definitions.push(definition);
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name));
});
const contextIdentity = computed(() => JSON.stringify([props.context.db_type, props.context.driver_profile, props.context.connection_string]));
const document = ref(parseConnectionParameters(""));
const entries = ref<ParameterEntry[]>([]);
const rawDraft = ref("");
const sourceAtOpen = ref("");
const contextAtOpen = ref("");
const mode = ref<"table" | "raw">("table");
const filter = ref("all");
const search = ref("");
const selectedId = ref("");
const rawVisible = ref(false);

interface Row {
  id: string;
  key: string;
  value: string;
  entry?: ParameterEntry;
  definition?: ConnectionParameterDefinition;
}
const rows = computed<Row[]>(() => {
  const configured = entries.value.map((entry) => ({ id: entry.id, key: entry.key, value: entry.value, entry, definition: parameterDefinitionForKey(catalog.value, entry.key) }));
  const defaults = catalog.value.filter((definition) => !entries.value.some((entry) => parameterDefinitionForKey([definition], entry.key))).map((definition) => ({ id: `default:${definition.name}`, key: definition.name, value: "", definition }));
  return [...configured, ...defaults];
});
const description = (definition?: ConnectionParameterDefinition): string => (!definition ? tr("customDescription") : definition.descriptionKey ? t(definition.descriptionKey) : locale.value.startsWith("zh") ? definition.descriptionZh || definition.description : definition.description);
const filteredRows = computed(() => {
  const query = search.value.trim().toLowerCase();
  return rows.value.filter((row) => (filter.value !== "configured" || !!row.entry) && (filter.value !== "custom" || (!!row.entry && !row.definition)) && (!query || `${row.key} ${description(row.definition)}`.toLowerCase().includes(query)));
});
const selected = computed(() => rows.value.find((row) => row.id === selectedId.value));
const selectedChoices = computed(() => selected.value?.definition?.choices ?? ["true", "false"]);
const serialized = computed(() => writeConnectionParameters(document.value, entries.value));
const externalChanged = computed(() => open.value && ((props.modelValue ?? "") !== sourceAtOpen.value || contextIdentity.value !== contextAtOpen.value));
const sensitive = computed(() => rows.value.some((row) => !!row.entry && (row.definition?.secret || parameterIsSecret(row.key))));
const entryError = (entry: ParameterEntry): string => {
  const original = document.value.entries.find((item) => item.id === entry.id);
  if (original && original.key === entry.key && original.value === entry.value && original.hasEquals === entry.hasEquals) return "";
  if (!entry.hasEquals) return "";
  const definition = parameterDefinitionForKey(catalog.value, entry.key);
  if (definition?.required && !entry.value) return tr("requiredError");
  const error = parameterValueError(definition, entry.value);
  return error ? tr(`${error}Error`) : "";
};
const invalid = computed(() => mode.value === "table" && (serialized.value.errors.length > 0 || entries.value.some((entry) => entryError(entry))));

function loadRaw(value: string) {
  document.value = parseConnectionParameters(value, syntax.value);
  entries.value = document.value.entries.map((entry) => ({ ...entry }));
  rawDraft.value = value;
  selectedId.value = rows.value[0]?.id ?? "";
}
function reset() {
  sourceAtOpen.value = props.modelValue ?? "";
  contextAtOpen.value = contextIdentity.value;
  mode.value = "table";
  filter.value = "all";
  search.value = "";
  loadRaw(sourceAtOpen.value);
  rawVisible.value = !sensitive.value;
}
watch(
  open,
  (value) => {
    if (value) reset();
  },
  { immediate: true },
);
function switchMode(next: "table" | "raw") {
  if (next === mode.value) return;
  if (next === "raw") {
    if (serialized.value.errors.length) return;
    rawDraft.value = serialized.value.value;
    rawVisible.value = !sensitive.value;
  } else loadRaw(rawDraft.value);
  mode.value = next;
}
function ensureEntry(row: Row): ParameterEntry {
  if (row.entry) return row.entry;
  const entry: ParameterEntry = { id: uuid(), key: row.key, value: "", hasEquals: true, editable: true };
  entries.value.push(entry);
  selectedId.value = entry.id;
  return entry;
}
function setValue(value: string | number) {
  if (!selected.value) return;
  const entry = ensureEntry(selected.value);
  entry.value = String(value);
  entry.hasEquals = true;
}
function addEntry(row?: Row) {
  const entry: ParameterEntry = { id: uuid(), key: row?.key ?? "", value: "", hasEquals: true, editable: true };
  entries.value.push(entry);
  filter.value = "all";
  search.value = "";
  selectedId.value = entry.id;
}
function removeEntry(id = selectedId.value) {
  const row = rows.value.find((row) => row.id === id);
  if (!row?.entry) return;
  const index = entries.value.findIndex((entry) => entry.id === id);
  entries.value = entries.value.filter((entry) => entry.id !== id);
  if (selectedId.value !== id) return;
  const sibling = row.definition && rows.value.find((item) => item.definition === row.definition);
  selectedId.value = sibling?.id ?? entries.value[index]?.id ?? entries.value[index - 1]?.id ?? rows.value[0]?.id ?? "";
}
function apply() {
  if (externalChanged.value || invalid.value) return;
  const value = mode.value === "raw" ? rawDraft.value : serialized.value.value;
  emit("apply", value);
  open.value = false;
}
function rowValue(row: Row): string {
  if (!row.entry) return row.definition?.defaultValue !== undefined && (row.definition.secret || parameterIsSecret(row.key)) ? "••••••••" : (row.definition?.defaultValue ?? tr("notSet"));
  if (row.definition?.secret || parameterIsSecret(row.key)) return "••••••••";
  return !row.entry.hasEquals ? tr("bareFlag") : row.value || tr("emptyValue");
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(720px,calc(100dvh-48px))] max-h-[calc(100dvh-48px)] flex-col gap-4 sm:max-w-[920px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ tr("title") }}</DialogTitle>
        <DialogDescription>{{ tr("description") }}</DialogDescription>
      </DialogHeader>
      <div v-if="externalChanged" role="alert" class="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 p-3 text-sm">
        <span>{{ tr("externalChanged") }}</span
        ><Button type="button" size="sm" variant="outline" @click="reset">{{ tr("reload") }}</Button>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="inline-flex rounded-md border p-0.5" role="group" :aria-label="tr('editMode')">
          <Button type="button" :aria-pressed="mode === 'table'" :variant="mode === 'table' ? 'secondary' : 'ghost'" size="sm" @click="switchMode('table')">{{ tr("tableMode") }}</Button>
          <Button type="button" :aria-pressed="mode === 'raw'" :variant="mode === 'raw' ? 'secondary' : 'ghost'" size="sm" :disabled="serialized.errors.length > 0" @click="switchMode('raw')">{{ tr("rawMode") }}</Button>
        </div>
        <Button v-if="mode === 'table'" type="button" size="sm" variant="outline" @click="addEntry()"><Plus class="mr-1.5 size-3.5" />{{ tr("add") }}</Button>
      </div>
      <template v-if="mode === 'table'">
        <div class="flex gap-2">
          <div class="relative min-w-0 flex-1"><Search class="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" /><Input v-model="search" class="pl-8" :aria-label="tr('search')" :placeholder="tr('search')" /></div>
          <Select v-model="filter"
            ><SelectTrigger class="w-36" :aria-label="tr('filter')"><SelectValue /></SelectTrigger
            ><SelectContent
              ><SelectItem value="all">{{ tr("all") }}</SelectItem
              ><SelectItem value="configured">{{ tr("configured") }}</SelectItem
              ><SelectItem value="custom">{{ tr("custom") }}</SelectItem></SelectContent
            ></Select
          >
        </div>
        <p v-if="loading" role="status" class="text-xs text-muted-foreground">{{ tr("loading") }}</p>
        <p v-if="metadataError" role="status" class="text-xs text-muted-foreground">{{ tr("metadataUnavailable") }}</p>
        <p v-if="document.issues.length" role="status" class="text-xs text-amber-700 dark:text-amber-400">{{ tr("opaqueHint") }}</p>
        <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto md:grid-cols-[minmax(0,1fr)_280px] md:overflow-hidden">
          <div class="min-h-32 min-w-0 overflow-auto rounded-md border" role="region" :aria-label="tr('parameterList')">
            <table class="w-full table-fixed text-sm">
              <thead class="sticky top-0 bg-muted text-left">
                <tr>
                  <th class="w-[45%] px-3 py-2 font-medium">{{ tr("name") }}</th>
                  <th class="w-[35%] px-3 py-2 font-medium">{{ tr("value") }}</th>
                  <th class="w-[20%] px-2 py-2 font-medium">{{ tr("state") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in filteredRows" :key="row.id" class="border-t" :class="selectedId === row.id ? 'bg-accent' : ''" :data-parameter-id="row.id">
                  <td class="px-3 py-2">
                    <button type="button" class="block w-full cursor-pointer truncate text-left font-mono text-xs hover:underline focus-visible:underline" :title="row.key" @click="selectedId = row.id">{{ row.key || tr("newParameter") }}</button>
                  </td>
                  <td class="truncate px-3 py-2 font-mono text-xs" :class="row.entry ? '' : 'text-muted-foreground'">{{ rowValue(row) }}</td>
                  <td class="px-2 py-1 text-xs text-muted-foreground">
                    <div class="flex items-center justify-between gap-1">
                      <span>{{ !row.entry ? tr("default") : row.definition ? tr("configured") : tr("custom") }}</span>
                      <Button v-if="row.entry && row.definition?.repeatable" type="button" variant="ghost" size="icon" class="size-6 shrink-0" :aria-label="`${tr('removeValue')} (${row.key})`" @click="removeEntry(row.id)"><Trash2 class="size-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!filteredRows.length" class="p-6 text-center text-sm text-muted-foreground">{{ tr("noMatches") }}</p>
          </div>
          <div v-if="selected" class="min-w-0 space-y-4 overflow-auto rounded-md border p-4" role="region" :aria-label="tr('details')">
            <div>
              <h3 class="break-all font-mono text-sm font-semibold">{{ selected.key || tr("newParameter") }}</h3>
              <p class="mt-2 text-xs leading-5 text-muted-foreground">{{ description(selected.definition) }}</p>
            </div>
            <div v-if="!selected.definition" class="space-y-1.5">
              <Label for="connection-parameter-name">{{ tr("name") }}</Label
              ><Input id="connection-parameter-name" :model-value="selected.key" :disabled="selected.entry && !selected.entry.editable" @update:model-value="ensureEntry(selected).key = String($event)" />
            </div>
            <div v-if="selected.definition?.defaultValue !== undefined" class="text-xs text-muted-foreground">
              {{ tr("defaultValue") }}: <span class="font-mono">{{ selected.definition.secret || parameterIsSecret(selected.key) ? "••••••••" : selected.definition.defaultValue }}</span>
            </div>
            <p v-if="selected.definition?.managedBy" class="rounded bg-muted p-2 text-xs leading-5">{{ tr("sharedSetting") }}</p>
            <p v-if="selected.entry && !selected.entry.editable" class="text-xs leading-5 text-amber-700 dark:text-amber-400">{{ tr("opaqueHint") }}</p>
            <div class="space-y-1.5">
              <Label for="connection-parameter-value">{{ tr("value") }}<span v-if="selected.definition?.required"> *</span></Label>
              <PasswordInput v-if="selected.definition?.secret || parameterIsSecret(selected.key)" id="connection-parameter-value" :model-value="selected.value" :disabled="selected.entry && !selected.entry.editable" @update:model-value="setValue($event || '')" />
              <Select :key="selected.id" v-else-if="selected.definition?.choices || selected.definition?.type === 'boolean'" :model-value="selected.value || undefined" :disabled="selected.entry && !selected.entry.editable" @update:model-value="setValue(String($event))">
                <SelectTrigger id="connection-parameter-value" class="w-full"><SelectValue :placeholder="selected.entry ? tr('emptyValue') : tr('default')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-if="selected.entry && selected.value && !selectedChoices.includes(selected.value)" :value="selected.value">{{ selected.value }}</SelectItem>
                  <SelectItem v-for="value in selectedChoices" :key="value" :value="value">{{ value }}</SelectItem>
                </SelectContent>
              </Select>
              <Input
                v-else
                id="connection-parameter-value"
                :model-value="selected.value"
                :inputmode="selected.definition?.type === 'integer' ? 'numeric' : undefined"
                :placeholder="selected.definition?.defaultValue || tr('notSet')"
                :disabled="selected.entry && !selected.entry.editable"
                @update:model-value="setValue($event)"
              />
              <p v-if="selected.entry && entryError(selected.entry)" role="alert" class="text-xs text-destructive">{{ entryError(selected.entry) }}</p>
            </div>
            <label v-if="selected.entry?.editable && !selected.definition" class="flex items-center gap-2 text-xs"><input type="checkbox" :checked="!selected.entry.hasEquals" @change="selected.entry.hasEquals = !($event.target as HTMLInputElement).checked" />{{ tr("bareFlag") }}</label>
            <div class="flex flex-wrap gap-2">
              <Button v-if="selected.entry" type="button" size="sm" variant="outline" @click="removeEntry()"
                ><RotateCcw v-if="selected.definition && !selected.definition.repeatable" class="mr-1.5 size-3.5" /><Trash2 v-else class="mr-1.5 size-3.5" />{{ selected.definition?.repeatable ? tr("removeValue") : selected.definition ? tr("reset") : tr("remove") }}</Button
              >
              <Button v-if="selected.definition?.repeatable" type="button" size="sm" variant="outline" @click="addEntry(selected)"><Copy class="mr-1.5 size-3.5" />{{ tr("addAnother") }}</Button>
            </div>
          </div>
          <p v-else class="p-4 text-sm text-muted-foreground">{{ tr("chooseParameter") }}</p>
        </div>
        <p v-if="serialized.errors.length" role="alert" class="text-xs text-destructive">{{ tr("serializationError") }}</p>
      </template>
      <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
        <p class="text-xs leading-5 text-muted-foreground">{{ tr("rawHint") }}</p>
        <template v-if="rawVisible"
          ><Label for="connection-parameter-raw">{{ tr("rawMode") }}</Label
          ><textarea id="connection-parameter-raw" v-model="rawDraft" class="min-h-40 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-sm" spellcheck="false" autocomplete="off" />
        </template>
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border">
          <p class="text-sm">{{ tr("sensitiveRaw") }}</p>
          <Button type="button" variant="outline" @click="rawVisible = true">{{ tr("revealRaw") }}</Button>
        </div>
      </div>
      <DialogFooter
        ><Button type="button" variant="outline" @click="open = false">{{ t("common.cancel") }}</Button
        ><Button type="button" :disabled="externalChanged || invalid" @click="apply">{{ tr("apply") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>

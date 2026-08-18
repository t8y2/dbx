<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ColorSpectrumPicker from "@/components/ui/ColorSpectrumPicker.vue";
import { Copy, Pencil, Plus, RotateCcw, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "@/composables/useTheme";
import { DATA_GRID_TYPE_COLOR_SCHEME_AUTO_ID, type DataGridTypeColorKey, type DataGridTypeColorScheme, defaultDataGridTypeColors, normalizeDataGridTypeColors } from "@/lib/dataGrid/dataGridTypeColorScheme";

interface Props {
  open: boolean;
  schemes: DataGridTypeColorScheme[];
  activeSchemeId: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "change", schemes: DataGridTypeColorScheme[], activeId: string): void;
}>();

const { t } = useI18n();
const { isDark } = useTheme();

const localSchemes = ref<DataGridTypeColorScheme[]>([]);
const activeEditId = ref(DATA_GRID_TYPE_COLOR_SCHEME_AUTO_ID);
const renamingId = ref<string | null>(null);
const renamingName = ref("");
function cloneSchemes(schemes: DataGridTypeColorScheme[]): DataGridTypeColorScheme[] {
  return schemes.map((scheme) => ({ ...scheme, colors: { ...scheme.colors } }));
}

// Everything below edits this buffer only. Nothing reaches the settings store
// until Done, so Cancel just drops it.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    localSchemes.value = cloneSchemes(props.schemes);
    activeEditId.value = props.activeSchemeId;
    renamingId.value = null;
  },
);

const typeColorItems: { key: DataGridTypeColorKey; labelKey: string; sample: string }[] = [
  { key: "integer", labelKey: "settings.dataGridTypeColorInteger", sample: "42" },
  { key: "numeric", labelKey: "settings.dataGridTypeColorNumeric", sample: "3.14" },
  { key: "string", labelKey: "settings.dataGridTypeColorString", sample: "'text'" },
  { key: "boolean", labelKey: "settings.dataGridTypeColorBoolean", sample: "true" },
  { key: "temporal", labelKey: "settings.dataGridTypeColorTemporal", sample: "2026-08-17" },
  { key: "structured", labelKey: "settings.dataGridTypeColorStructured", sample: '{"a": 1}' },
  { key: "identifier", labelKey: "settings.dataGridTypeColorIdentifier", sample: "9f8e-4c1a" },
  { key: "binary", labelKey: "settings.dataGridTypeColorBinary", sample: "0x1F8B" },
  { key: "spatial", labelKey: "settings.dataGridTypeColorSpatial", sample: "POINT(0 0)" },
];

/** The auto entry is a sentinel rather than a stored scheme, so it has no editable colors. */
const isFollowingTheme = computed(() => activeEditId.value === DATA_GRID_TYPE_COLOR_SCHEME_AUTO_ID);

const activeScheme = computed(() => localSchemes.value.find((scheme) => scheme.id === activeEditId.value));

// Falls back to the built-in palette so the auto entry still previews real colors.
const displayedColors = computed(() => activeScheme.value?.colors ?? defaultDataGridTypeColors(isDark.value));

function updateColor(key: DataGridTypeColorKey, value: string) {
  const scheme = activeScheme.value;
  if (!scheme) return;
  const trimmed = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return;
  scheme.colors = { ...scheme.colors, [key]: trimmed.toLowerCase() };
}

function nextSchemeName(): string {
  return `${t("settings.dataGridTypeColorSchemeDefaultName")} ${localSchemes.value.length + 1}`;
}

function selectScheme(id: string) {
  activeEditId.value = id;
}

function addScheme() {
  const id = `type-colors-${Date.now()}`;
  // Seed from whatever is on screen so a new scheme starts as a visible tweak.
  localSchemes.value.push({ id, name: nextSchemeName(), colors: { ...displayedColors.value } });
  activeEditId.value = id;
}

function duplicateScheme() {
  const scheme = activeScheme.value;
  if (!scheme) return;
  const id = `type-colors-${Date.now()}`;
  localSchemes.value.push({ id, name: `${scheme.name}${t("settings.dataGridTypeColorSchemeCopySuffix")}`, colors: { ...scheme.colors } });
  activeEditId.value = id;
}

function deleteScheme() {
  const scheme = activeScheme.value;
  if (!scheme) return;
  localSchemes.value = localSchemes.value.filter((entry) => entry.id !== scheme.id);
  activeEditId.value = DATA_GRID_TYPE_COLOR_SCHEME_AUTO_ID;
}

function resetScheme() {
  const scheme = activeScheme.value;
  if (!scheme) return;
  scheme.colors = { ...defaultDataGridTypeColors(isDark.value) };
}

function startRename() {
  const scheme = activeScheme.value;
  if (!scheme) return;
  renamingId.value = scheme.id;
  renamingName.value = scheme.name;
}

function confirmRename() {
  const scheme = localSchemes.value.find((entry) => entry.id === renamingId.value);
  const name = renamingName.value.trim();
  if (scheme && name) scheme.name = name;
  renamingId.value = null;
}

/** The single commit point: the edit buffer becomes the applied settings. */
function handleDone() {
  emit(
    "change",
    cloneSchemes(localSchemes.value).map((scheme) => ({ ...scheme, colors: normalizeDataGridTypeColors(scheme.colors) })),
    activeEditId.value,
  );
  emit("update:open", false);
}

/** Drops the edit buffer; the store never saw any of it. */
function handleCancel() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ t("settings.dataGridTypeColorSchemeTitle") }}</DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <p class="text-xs text-muted-foreground">
          {{ t("settings.dataGridTypeColorSchemeDescription") }}
        </p>

        <!-- Scheme selector + management -->
        <div class="flex items-end gap-2">
          <div class="flex-1 min-w-0 space-y-2">
            <label class="text-sm font-medium">{{ t("settings.dataGridTypeColorScheme") }}</label>
            <Select :model-value="activeEditId" @update:model-value="selectScheme(String($event))">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="DATA_GRID_TYPE_COLOR_SCHEME_AUTO_ID">
                  {{ t("settings.dataGridTypeColorSchemeAuto") }}
                </SelectItem>
                <SelectItem v-for="scheme in localSchemes" :key="scheme.id" :value="scheme.id">
                  {{ scheme.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" class="h-9" :title="t('settings.dataGridTypeColorSchemeAdd')" @click="addScheme">
            <Plus class="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" class="h-9" :disabled="isFollowingTheme" :title="t('settings.dataGridTypeColorSchemeDuplicate')" @click="duplicateScheme">
            <Copy class="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" class="h-9" :disabled="isFollowingTheme" :title="t('settings.dataGridTypeColorSchemeRename')" @click="startRename">
            <Pencil class="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" class="h-9" :disabled="isFollowingTheme" :title="t('settings.dataGridTypeColorSchemeDelete')" @click="deleteScheme">
            <Trash2 class="h-4 w-4" />
          </Button>
        </div>

        <div v-if="renamingId" class="flex items-center gap-2">
          <Input v-model="renamingName" class="h-8" @keydown.enter="confirmRename" />
          <Button size="sm" @click="confirmRename">{{ t("settings.dataGridTypeColorSchemeRenameConfirm") }}</Button>
        </div>

        <div v-if="isFollowingTheme" class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
          <p class="text-xs text-muted-foreground">
            {{ t("settings.dataGridTypeColorSchemeAutoHint") }}
          </p>
          <Button variant="outline" size="sm" class="shrink-0" @click="addScheme">
            {{ t("settings.dataGridTypeColorSchemeCreateFromCurrent") }}
          </Button>
        </div>

        <!-- Color rows -->
        <div class="grid gap-2 sm:grid-cols-2" :class="{ 'opacity-60': isFollowingTheme }">
          <div v-for="item in typeColorItems" :key="item.key" class="flex items-center gap-2 rounded-md border px-2 py-1.5">
            <div class="min-w-0 flex-1">
              <div class="truncate text-xs font-medium">{{ t(item.labelKey) }}</div>
              <div class="truncate font-mono text-xs" :style="{ color: displayedColors[item.key] }">{{ item.sample }}</div>
            </div>
            <input
              type="text"
              class="w-[74px] shrink-0 rounded border bg-transparent px-1.5 py-0.5 font-mono text-xs disabled:cursor-not-allowed"
              :value="displayedColors[item.key]"
              :disabled="isFollowingTheme"
              spellcheck="false"
              @change="updateColor(item.key, ($event.target as HTMLInputElement).value)"
            />
            <ColorSpectrumPicker :model-value="displayedColors[item.key]" :disabled="isFollowingTheme" :label="t(item.labelKey)" @update:model-value="updateColor(item.key, $event)" />
          </div>
        </div>
      </div>

      <DialogFooter class="gap-2">
        <Button variant="outline" :disabled="isFollowingTheme" class="mr-auto" @click="resetScheme">
          <RotateCcw class="mr-2 h-4 w-4" />
          {{ t("settings.dataGridTypeColorSchemeReset") }}
        </Button>
        <Button variant="outline" @click="handleCancel">{{ t("settings.cancel") }}</Button>
        <Button @click="handleDone">{{ t("settings.dataGridTypeColorSchemeDone") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DEFAULT_DATA_GRID_FONT_FAMILY } from "@/lib/app/appFonts";
import { buildFontFamilyOptions, displayFontFamily, loadSystemFontNames } from "@/lib/app/fontFamilyOptions";
import { useSettingsStore } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const systemFontNames = ref<string[]>([]);
const tableFontFamily = computed(() => settingsStore.editorSettings.tableFontFamily);
const tableFontOptions = computed(() => buildFontFamilyOptions(systemFontNames.value, [tableFontFamily.value], [DEFAULT_DATA_GRID_FONT_FAMILY]));

function setTableFontFamily(value: string) {
  settingsStore.updateEditorSettings({ tableFontFamily: value });
}

async function loadSystemFontOptions() {
  try {
    systemFontNames.value = await loadSystemFontNames();
  } catch {
    systemFontNames.value = [];
  }
}
</script>

<template>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
    <div class="min-w-0 flex items-center gap-2 font-medium">
      <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[9px] font-semibold text-muted-foreground">Aa</span>
      <span>{{ t("grid.tableFontFamily") }}</span>
    </div>
    <SearchableSelect
      :model-value="tableFontFamily"
      :options="tableFontOptions"
      :placeholder="t('settings.selectFont')"
      :search-placeholder="t('settings.searchFont')"
      :empty-text="t('settings.noFontsFound')"
      :display-name="displayFontFamily"
      trigger-variant="outline"
      trigger-class="h-6 w-48 max-w-48 justify-between bg-muted/40 px-2 text-xs"
      content-class="w-64 max-w-[calc(100vw-2rem)]"
      @update:model-value="setTableFontFamily"
      @update:open="(open: boolean) => open && loadSystemFontOptions()"
    >
      <template #trigger-label="{ label }">
        <span class="truncate" :style="{ fontFamily: tableFontFamily }">{{ label }}</span>
      </template>
      <template #option-label="{ option, label }">
        <span class="truncate" :style="{ fontFamily: option }">{{ label }}</span>
      </template>
    </SearchableSelect>
  </div>
</template>

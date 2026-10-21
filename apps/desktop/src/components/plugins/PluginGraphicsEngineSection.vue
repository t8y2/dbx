<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Palette } from "@lucide/vue";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { isPluginGraphicsEngineEnabled, withPluginGraphicsEngineEnabled } from "@/lib/plugins/pluginGraphicsEngine";
import type { InstalledPlugin } from "@/types/database";

const props = defineProps<{ plugin: InstalledPlugin }>();

const { t } = useI18n();
const { toast } = useToast();
const settings = useSettingsStore();

const pluginId = computed(() => props.plugin.manifest.id);
// Only a plugin that ships a UI can render through a graphics engine.
const hasUi = computed(() => !!props.plugin.manifest.entrypoints?.ui);
const enabled = computed(() => isPluginGraphicsEngineEnabled(settings.editorSettings.pluginGraphicsEngineIds, pluginId.value));
const saving = ref(false);

async function setEnabled(next: boolean) {
  if (saving.value) return;
  saving.value = true;
  try {
    await settings.updateEditorSettingsAndPersist({
      pluginGraphicsEngineIds: withPluginGraphicsEngineEnabled(settings.editorSettings.pluginGraphicsEngineIds, pluginId.value, next),
    });
  } catch (error) {
    toast(t("pluginPlatform.graphicsEngine.saveFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section v-if="hasUi" class="space-y-3 rounded-lg border p-4" data-plugin-graphics-engine>
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 items-start gap-2">
        <Palette class="mt-0.5 size-4 shrink-0 text-primary" />
        <div class="min-w-0">
          <div class="text-sm font-medium">{{ t("pluginPlatform.graphicsEngine.title") }}</div>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.graphicsEngine.description") }}</p>
        </div>
      </div>
      <Switch :model-value="enabled" :disabled="saving" :aria-label="t('pluginPlatform.graphicsEngine.title')" @update:model-value="setEnabled($event === true)" />
    </div>
    <div class="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-[11px] leading-4 text-muted-foreground">{{ t("pluginPlatform.graphicsEngine.securityNote") }}</div>
  </section>
</template>

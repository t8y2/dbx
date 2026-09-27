<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, Database, Loader2, ShieldCheck, TriangleAlert, X } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/composables/useToast";
import type { InstalledPlugin } from "@/types/database";
import type { PluginDataGrant } from "@/types/pluginData";
import { PLUGIN_DATA_READ_PERMISSION } from "@/types/pluginData";
import type { PluginToolPreview } from "@/types/pluginAiTools";

/**
 * Plugin Center controls for what a plugin may reach beyond its own UI:
 * built-in AI access to its MCP tools, and the connections it may read
 * through `host.data:read`. Both are off until the user turns them on.
 */
const props = defineProps<{ plugin: InstalledPlugin }>();

const { t } = useI18n();
const { toast } = useToast();

const pluginId = computed(() => props.plugin.manifest.id);
const hasBackend = computed(() => !!props.plugin.manifest.entrypoints?.backend);
const declaresDataRead = computed(() => (props.plugin.manifest.permissions || []).includes(PLUGIN_DATA_READ_PERMISSION));

const aiEnabled = ref(false);
const aiSaving = ref(false);
const preview = ref<PluginToolPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref("");
const grants = ref<PluginDataGrant[]>([]);
const revoking = ref<string | null>(null);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function load() {
  preview.value = null;
  previewError.value = "";
  grants.value = [];
  const id = pluginId.value;
  const [enabledIds, currentGrants] = await Promise.all([
    hasBackend.value ? api.getAiPluginToolPlugins().catch(() => [] as string[]) : Promise.resolve([] as string[]),
    declaresDataRead.value ? api.getPluginDataGrants(id).catch(() => [] as PluginDataGrant[]) : Promise.resolve([] as PluginDataGrant[]),
  ]);
  // The selection may have moved on while the requests were in flight.
  if (id !== pluginId.value) return;
  aiEnabled.value = enabledIds.includes(id);
  grants.value = currentGrants;
}

async function setAiEnabled(enabled: boolean) {
  if (aiSaving.value) return;
  aiSaving.value = true;
  try {
    const enabledIds = await api.setAiPluginToolPluginEnabled(pluginId.value, enabled);
    aiEnabled.value = enabledIds.includes(pluginId.value);
  } catch (error) {
    toast(t("pluginPlatform.aiTools.saveFailed", { message: errorText(error) }), 5000);
  } finally {
    aiSaving.value = false;
  }
}

async function loadPreview() {
  previewLoading.value = true;
  previewError.value = "";
  const id = pluginId.value;
  try {
    const result = await api.previewPluginAiTools(id);
    if (id === pluginId.value) preview.value = result;
  } catch (error) {
    if (id === pluginId.value) previewError.value = errorText(error);
  } finally {
    previewLoading.value = false;
  }
}

async function revokeGrant(connectionId: string) {
  revoking.value = connectionId;
  try {
    grants.value = await api.setPluginDataGrant(pluginId.value, connectionId, false);
  } catch (error) {
    toast(t("pluginPlatform.dataAccess.revokeFailed", { message: errorText(error) }), 5000);
  } finally {
    revoking.value = null;
  }
}

watch(pluginId, () => void load(), { immediate: true });
</script>

<template>
  <div v-if="hasBackend || declaresDataRead" class="space-y-3">
    <section v-if="hasBackend" class="space-y-3 rounded-lg border p-4" data-plugin-ai-tools>
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-start gap-2">
          <Bot class="mt-0.5 size-4 shrink-0 text-primary" />
          <div class="min-w-0">
            <div class="text-sm font-medium">{{ t("pluginPlatform.aiTools.title") }}</div>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.aiTools.description") }}</p>
          </div>
        </div>
        <Switch :model-value="aiEnabled" :disabled="aiSaving" :aria-label="t('pluginPlatform.aiTools.title')" @update:model-value="setAiEnabled($event === true)" />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" class="h-7 gap-1.5 text-xs" :disabled="previewLoading" @click="loadPreview">
          <Loader2 v-if="previewLoading" class="size-3.5 animate-spin" />
          {{ t("pluginPlatform.aiTools.preview") }}
        </Button>
        <span class="text-[11px] text-muted-foreground">{{ t("pluginPlatform.aiTools.previewHint") }}</span>
      </div>
      <div v-if="previewError" class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
        <span class="min-w-0 break-words">{{ t("pluginPlatform.aiTools.previewFailed", { message: previewError }) }}</span>
      </div>
      <div v-else-if="preview" class="space-y-2">
        <div class="text-[11px] text-muted-foreground">
          {{ preview.openConnections.length ? t("pluginPlatform.aiTools.openConnections", { names: preview.openConnections.map((connection) => connection.name).join(", ") }) : t("pluginPlatform.aiTools.noOpenConnections") }}
        </div>
        <div v-if="!preview.tools.length" class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{{ t("pluginPlatform.aiTools.noTools") }}</div>
        <ul v-else class="max-h-64 divide-y overflow-y-auto rounded-md border">
          <li v-for="tool in preview.tools" :key="tool.name" class="flex items-start gap-2 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="font-mono text-xs">{{ tool.name }}</div>
              <div v-if="tool.description" class="mt-0.5 text-[11px] leading-4 text-muted-foreground">{{ tool.description }}</div>
            </div>
            <Badge v-if="tool.readOnly" variant="secondary" class="h-5 shrink-0 gap-1 px-1.5 text-[10px]"><ShieldCheck class="size-3" />{{ t("pluginPlatform.aiTools.readOnly") }}</Badge>
            <Badge v-else variant="outline" class="h-5 shrink-0 border-amber-500/40 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("pluginPlatform.aiTools.needsApproval") }}</Badge>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="declaresDataRead" class="space-y-3 rounded-lg border p-4" data-plugin-data-access>
      <div class="flex min-w-0 items-start gap-2">
        <Database class="mt-0.5 size-4 shrink-0 text-primary" />
        <div class="min-w-0">
          <div class="text-sm font-medium">{{ t("pluginPlatform.dataAccess.title") }}</div>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("pluginPlatform.dataAccess.description") }}</p>
        </div>
      </div>
      <div v-if="!grants.length" class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{{ t("pluginPlatform.dataAccess.none") }}</div>
      <ul v-else class="divide-y rounded-md border">
        <li v-for="grant in grants" :key="grant.connectionId" class="flex items-center gap-2 px-3 py-2">
          <div class="min-w-0 flex-1 truncate text-xs">
            <span v-if="grant.connectionName">{{ grant.connectionName }}</span>
            <span v-else class="text-muted-foreground">{{ t("pluginPlatform.dataAccess.missingConnection", { id: grant.connectionId }) }}</span>
          </div>
          <Button size="sm" variant="ghost" class="h-6 gap-1 px-2 text-xs text-destructive" :disabled="revoking === grant.connectionId" @click="revokeGrant(grant.connectionId)">
            <Loader2 v-if="revoking === grant.connectionId" class="size-3 animate-spin" />
            <X v-else class="size-3" />
            {{ t("pluginPlatform.dataAccess.revoke") }}
          </Button>
        </li>
      </ul>
    </section>
  </div>
</template>

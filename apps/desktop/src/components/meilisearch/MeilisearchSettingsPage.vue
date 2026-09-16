<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Save } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import JsonTree from "@/components/common/JsonTree.vue";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import * as api from "@/lib/backend/api";
import { useToast } from "@/composables/useToast";
import { useQueryStore } from "@/stores/queryStore";

const props = defineProps<{
  connectionId: string;
  index: string;
}>();

const emit = defineEmits<{
  "refresh-stats": [];
}>();

const { t } = useI18n();
const { toast } = useToast();
const queryStore = useQueryStore();

const settingsText = ref("");
const settingsValue = ref<Record<string, any>>({});
const loading = ref(false);
const error = ref("");
const editMode = ref(false);
const isSaving = ref(false);
const saveError = ref("");

const clearConfirmOpen = ref(false);
const isClearing = ref(false);
const deleteIndexConfirmOpen = ref(false);
const isDeletingIndex = ref(false);

async function loadSettings() {
  loading.value = true;
  error.value = "";
  try {
    const settings = await api.meilisearchGetIndexSettings(props.connectionId, props.index);
    settingsValue.value = settings ?? {};
    settingsText.value = JSON.stringify(settingsValue.value, null, 2);
  } catch (e: any) {
    settingsValue.value = {};
    settingsText.value = "{}";
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function startEdit() {
  saveError.value = "";
  editMode.value = true;
}

function cancelEdit() {
  saveError.value = "";
  editMode.value = false;
}

async function saveSettings() {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsText.value);
  } catch {
    saveError.value = t("meilisearch.invalidJson");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    saveError.value = t("meilisearch.invalidJson");
    return;
  }

  isSaving.value = true;
  saveError.value = "";
  try {
    await api.meilisearchUpdateIndexSettings(props.connectionId, props.index, parsed as Record<string, any>);
    toast(t("meilisearch.settingsSaved"));
    settingsValue.value = parsed as Record<string, any>;
    settingsText.value = JSON.stringify(parsed, null, 2);
    editMode.value = false;
  } catch (e: any) {
    saveError.value = e?.message || String(e);
  } finally {
    isSaving.value = false;
  }
}

async function confirmClearDocuments() {
  isClearing.value = true;
  try {
    await api.meilisearchDeleteAllDocuments(props.connectionId, props.index);
    toast(t("meilisearch.documentsCleared"));
    clearConfirmOpen.value = false;
    emit("refresh-stats");
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    isClearing.value = false;
  }
}

async function confirmDeleteIndex() {
  // Capture the owning tab id up front: the delete is awaited, and the user
  // may switch tabs meanwhile, so reading the active tab afterwards could
  // close an unrelated tab.
  const ownerTabId = queryStore.activeTabId;
  isDeletingIndex.value = true;
  try {
    await api.meilisearchDeleteIndex(props.connectionId, props.index);
    toast(t("meilisearch.indexDeleted"));
    deleteIndexConfirmOpen.value = false;
    // The tab may have been closed while the delete was in flight.
    if (ownerTabId && queryStore.tabs.some((tab) => tab.id === ownerTabId)) queryStore.closeTab(ownerTabId);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    isDeletingIndex.value = false;
  }
}

onMounted(() => {
  void loadSettings();
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
      <QueryLoadingState v-if="loading" class="py-8" />
      <ErrorBanner v-else-if="error" :message="error" />

      <template v-else>
        <!-- Settings JSON -->
        <div class="rounded-lg border bg-card p-3 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-medium">{{ t("meilisearch.settingsJson") }}</div>
            <div class="flex items-center gap-1">
              <template v-if="!editMode">
                <Button variant="ghost" size="sm" class="h-6 text-xs" @click="startEdit">{{ t("common.edit") }}</Button>
              </template>
              <template v-else>
                <Button variant="ghost" size="sm" class="h-6 text-xs" :disabled="isSaving" @click="cancelEdit">{{ t("common.cancel") }}</Button>
                <Button size="sm" class="h-6 gap-1 text-xs" :disabled="isSaving" @click="saveSettings">
                  <Save class="h-3 w-3" />
                  {{ t("common.save") }}
                </Button>
              </template>
            </div>
          </div>
          <div v-if="!editMode" class="max-h-[60vh] overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs">
            <JsonTree :value="settingsValue" />
          </div>
          <div v-else class="h-[60vh] min-h-0 overflow-hidden rounded-md border bg-muted/20">
            <RedisJsonEditor v-model="settingsText" class="h-full" :read-only="isSaving" />
          </div>
          <div v-if="saveError" class="text-xs text-destructive">{{ saveError }}</div>
        </div>

        <!-- Danger zone -->
        <div class="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
          <div class="text-sm font-medium text-destructive">{{ t("meilisearch.dangerZone") }}</div>
          <div class="flex flex-wrap items-center gap-2">
            <Button variant="destructive" size="sm" class="h-7 text-xs" @click="clearConfirmOpen = true">
              {{ t("meilisearch.clearDocuments") }}
            </Button>
            <Button variant="destructive" size="sm" class="h-7 text-xs" @click="deleteIndexConfirmOpen = true">
              {{ t("meilisearch.deleteIndex") }}
            </Button>
          </div>
        </div>
      </template>
    </div>

    <DangerConfirmDialog v-model:open="clearConfirmOpen" :message="t('meilisearch.clearDocumentsConfirmMessage')" :confirm-label="t('meilisearch.clearDocuments')" :loading="isClearing" @confirm="confirmClearDocuments" />
    <DangerConfirmDialog v-model:open="deleteIndexConfirmOpen" :title="t('meilisearch.deleteIndex')" :message="t('meilisearch.deleteIndexConfirmMessage')" :confirm-label="t('meilisearch.deleteIndex')" :loading="isDeletingIndex" @confirm="confirmDeleteIndex" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/api";
import type { SchemaRegistrySchemaDetail } from "@/types/database";

const props = defineProps<{ connectionId: string; subject: string }>();

const { t } = useI18n();

const loadingVersions = ref(false);
const loadingSchema = ref(false);
const versions = ref<number[]>([]);
const selectedVersion = ref("");
const detail = ref<SchemaRegistrySchemaDetail | null>(null);
const error = ref("");

const formattedSchema = computed(() => {
  if (!detail.value?.schema) return "";
  try {
    return JSON.stringify(JSON.parse(detail.value.schema), null, 2);
  } catch {
    return detail.value.schema;
  }
});

async function loadVersions() {
  loadingVersions.value = true;
  error.value = "";
  try {
    versions.value = await api.kafkaSchemaRegistryListVersions(props.connectionId, props.subject);
    if (versions.value.length > 0) {
      selectedVersion.value = String(versions.value[versions.value.length - 1]);
      await loadSchema();
    } else {
      selectedVersion.value = "";
      detail.value = null;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    versions.value = [];
    detail.value = null;
  } finally {
    loadingVersions.value = false;
  }
}

async function loadSchema() {
  if (!selectedVersion.value) return;
  loadingSchema.value = true;
  error.value = "";
  try {
    detail.value = await api.kafkaSchemaRegistryGetSchema(props.connectionId, props.subject, selectedVersion.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    detail.value = null;
  } finally {
    loadingSchema.value = false;
  }
}

watch(
  () => [props.connectionId, props.subject],
  () => {
    versions.value = [];
    selectedVersion.value = "";
    detail.value = null;
    void loadVersions();
  },
);

watch(selectedVersion, (version) => {
  if (version) void loadSchema();
});

onMounted(() => void loadVersions());
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">{{ subject }}</div>
        <div v-if="detail" class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="outline">{{ detail.schemaType }}</Badge>
          <span>{{ t("kafka.schemaId", { id: detail.schemaId }) }}</span>
        </div>
      </div>
      <Select v-model="selectedVersion" :disabled="loadingVersions || versions.length === 0">
        <SelectTrigger class="h-8 w-28">
          <SelectValue :placeholder="t('kafka.schemaVersion')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="version in versions" :key="version" :value="String(version)"> v{{ version }} </SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loadingVersions || loadingSchema" @click="loadVersions">
        <Loader2 v-if="loadingVersions || loadingSchema" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-3">
      <div v-if="error" class="text-sm text-destructive">{{ error }}</div>
      <div v-else-if="loadingSchema" class="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {{ t("kafka.loadingSchema") }}
      </div>
      <pre v-else-if="detail" class="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">{{ formattedSchema }}</pre>
      <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">
        {{ t("kafka.noSchemaSelected") }}
      </div>
    </div>
  </div>
</template>

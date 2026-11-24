<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronRight, Database, Loader2, Server } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { buildMongoCreateCollectionRequest, defaultMongoCreateCollectionForm, mongoCreateCollectionPreview, type MongoCreateCollectionFormError, type MongoCreateCollectionKind } from "@/lib/sidebar/mongoCollectionMutation";
import { runMongoSidebarMutation } from "@/lib/sidebar/runMongoSidebarMutation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ connectionId: string; database: string }>();

const form = ref(defaultMongoCreateCollectionForm());
const activeTab = ref("options");
const error = ref("");
const loading = ref(false);
const connectionName = computed(() => connectionStore.getConfig(props.connectionId)?.name ?? "");

const KINDS: MongoCreateCollectionKind[] = ["default", "capped", "timeseries", "clustered"];

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    form.value = defaultMongoCreateCollectionForm();
    activeTab.value = "options";
    error.value = "";
    loading.value = false;
  },
  { immediate: true },
);

const request = computed(() => buildMongoCreateCollectionRequest(form.value));

function formErrorMessage(failure: MongoCreateCollectionFormError): string {
  if (failure.error === "name") return failure.reason === "required" ? "" : t(`mongo.createCollectionNameInvalid.${failure.reason}`);
  return t(`mongo.createCollectionFormError.${failure.error}`);
}

const formError = computed(() => (request.value.valid ? "" : formErrorMessage(request.value)));
const preview = computed(() => (request.value.valid ? mongoCreateCollectionPreview(props.database, request.value.name, request.value.options) : ""));
const canSubmit = computed(() => request.value.valid && !loading.value);

async function confirm() {
  const current = request.value;
  if (!current.valid || loading.value) return;
  const { connectionId, database } = props;
  error.value = "";
  await runMongoSidebarMutation({
    connection: connectionStore.getConfig(connectionId),
    database,
    reviewText: preview.value,
    source: t("production.sourceSidebar"),
    loading,
    beforeExecute: () => connectionStore.ensureConnected(connectionId),
    execute: () => api.mongoRunCommand(connectionId, database, JSON.stringify({ create: current.name, ...current.options })),
    onSuccess: async () => {
      toast(t("mongo.createCollectionSuccess", { name: current.name }), 3000);
      open.value = false;
      try {
        await connectionStore.loadMongoCollections(connectionId, database);
      } catch {
        // The collection exists; a failed tree refresh only delays it showing up.
      }
    },
    onError: (e) => {
      error.value = translateBackendError(t, e instanceof Error ? e.message : String(e));
    },
  });
}

const fieldClass = "h-8 text-xs";
const selectClass = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50";
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[85vh] flex-col gap-3 sm:max-w-[600px]" data-mongo-create-collection-dialog>
      <DialogHeader>
        <DialogTitle>{{ t("mongo.createCollectionTitle") }}</DialogTitle>
        <nav class="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" :aria-label="t('mongo.breadcrumb')">
          <span v-if="connectionName" class="inline-flex min-w-0 items-center gap-1" :title="connectionName"
            ><Server class="h-3 w-3 shrink-0" /><span class="truncate">{{ connectionName }}</span></span
          >
          <ChevronRight v-if="connectionName" class="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
          <span class="inline-flex min-w-0 items-center gap-1 font-medium text-foreground" :title="database"
            ><Database class="h-3 w-3 shrink-0" /><span class="truncate">{{ database }}</span></span
          >
        </nav>
      </DialogHeader>

      <div class="grid grid-cols-[auto_1fr] items-center gap-2">
        <label for="mongo-create-collection-name" class="text-xs font-medium">{{ t("mongo.createCollectionNameLabel") }}</label>
        <Input id="mongo-create-collection-name" v-model="form.name" :placeholder="t('mongo.createCollectionNamePlaceholder')" :disabled="loading" autofocus class="h-8" @keydown.enter.prevent="confirm" />
      </div>

      <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col">
        <TabsList class="shrink-0">
          <TabsTrigger value="options">{{ t("mongo.createCollectionTabOptions") }}</TabsTrigger>
          <TabsTrigger value="validator">{{ t("mongo.createCollectionTabValidator") }}</TabsTrigger>
          <TabsTrigger value="collation">{{ t("mongo.createCollectionTabCollation") }}</TabsTrigger>
        </TabsList>

        <TabsContent value="options" class="min-h-0 space-y-3 overflow-y-auto rounded-md border p-3" data-tab="options">
          <template v-for="kind in KINDS" :key="kind">
            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.kind" type="radio" :value="kind" class="h-3.5 w-3.5 accent-primary" :disabled="loading" />
              {{ t(`mongo.createCollectionKind.${kind}`) }}
            </label>
            <div v-if="kind === 'capped'" class="grid grid-cols-[11rem_1fr] items-center gap-2 pl-6" :class="{ 'opacity-50': form.kind !== 'capped' }">
              <span class="text-xs">{{ t("mongo.createCollectionCappedSize") }}</span>
              <Input v-model="form.cappedSize" inputmode="numeric" :class="fieldClass" :disabled="loading || form.kind !== 'capped'" />
              <span class="text-xs">{{ t("mongo.createCollectionCappedMax") }}</span>
              <Input v-model="form.cappedMax" inputmode="numeric" :placeholder="t('mongo.createCollectionOptional')" :class="fieldClass" :disabled="loading || form.kind !== 'capped'" />
            </div>
            <div v-else-if="kind === 'timeseries'" class="grid grid-cols-[11rem_1fr] items-center gap-2 pl-6" :class="{ 'opacity-50': form.kind !== 'timeseries' }">
              <span class="text-xs">{{ t("mongo.createCollectionTimeField") }}</span>
              <Input v-model="form.timeField" :class="fieldClass" :disabled="loading || form.kind !== 'timeseries'" />
              <span class="text-xs">{{ t("mongo.createCollectionMetaField") }}</span>
              <Input v-model="form.metaField" :placeholder="t('mongo.createCollectionOptional')" :class="fieldClass" :disabled="loading || form.kind !== 'timeseries'" />
              <span class="text-xs">{{ t("mongo.createCollectionGranularity") }}</span>
              <select v-model="form.granularity" :class="selectClass" :disabled="loading || form.kind !== 'timeseries'">
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
              <span class="text-xs">{{ t("mongo.createCollectionExpireAfter") }}</span>
              <Input v-model="form.expireAfterSeconds" inputmode="numeric" :placeholder="t('mongo.createCollectionOptional')" :class="fieldClass" :disabled="loading || form.kind !== 'timeseries'" />
            </div>
            <div v-else-if="kind === 'clustered'" class="grid grid-cols-[11rem_1fr] items-center gap-2 pl-6" :class="{ 'opacity-50': form.kind !== 'clustered' }">
              <span class="text-xs">{{ t("mongo.createCollectionClusteredIndexName") }}</span>
              <Input v-model="form.clusteredIndexName" :placeholder="t('mongo.createCollectionOptional')" :class="fieldClass" :disabled="loading || form.kind !== 'clustered'" />
            </div>
          </template>
        </TabsContent>

        <TabsContent value="validator" class="min-h-0 space-y-3 rounded-md border p-3" data-tab="validator">
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-xs">
              <span>{{ t("mongo.createCollectionValidationLevel") }}</span>
              <select v-model="form.validationLevel" :class="selectClass" :disabled="loading">
                <option value="strict">strict</option>
                <option value="moderate">moderate</option>
                <option value="off">off</option>
              </select>
            </label>
            <label class="space-y-1 text-xs">
              <span>{{ t("mongo.createCollectionValidationAction") }}</span>
              <select v-model="form.validationAction" :class="selectClass" :disabled="loading">
                <option value="error">error</option>
                <option value="warn">warn</option>
              </select>
            </label>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("mongo.createCollectionValidatorHint") }}</p>
          <div class="h-48 overflow-hidden rounded border bg-background">
            <RedisJsonEditor v-model="form.validator" class="h-full" :read-only="loading" />
          </div>
        </TabsContent>

        <TabsContent value="collation" class="min-h-0 space-y-3 rounded-md border p-3" data-tab="collation">
          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.useCollation" type="checkbox" class="h-3.5 w-3.5 accent-primary" :disabled="loading" />
            {{ t("mongo.createCollectionUseCollation") }}
          </label>
          <div class="grid grid-cols-[11rem_1fr] items-center gap-2" :class="{ 'opacity-50': !form.useCollation }">
            <span class="text-xs">{{ t("mongo.createCollectionLocale") }}</span>
            <Input v-model="form.collationLocale" placeholder="en, th, en_US, simple" :class="fieldClass" :disabled="loading || !form.useCollation" />
            <span class="text-xs">{{ t("mongo.createCollectionStrength") }}</span>
            <select v-model="form.collationStrength" :class="selectClass" :disabled="loading || !form.useCollation">
              <option value="">{{ t("mongo.createCollectionNotSet") }}</option>
              <option v-for="level in ['1', '2', '3', '4', '5']" :key="level" :value="level">{{ level }}</option>
            </select>
            <span class="text-xs">{{ t("mongo.createCollectionCaseFirst") }}</span>
            <select v-model="form.collationCaseFirst" :class="selectClass" :disabled="loading || !form.useCollation">
              <option value="">{{ t("mongo.createCollectionNotSet") }}</option>
              <option value="upper">upper</option>
              <option value="lower">lower</option>
              <option value="off">off</option>
            </select>
            <span class="text-xs">{{ t("mongo.createCollectionNumericOrdering") }}</span>
            <label class="flex items-center gap-2 text-xs">
              <input v-model="form.collationNumericOrdering" type="checkbox" class="h-3.5 w-3.5 accent-primary" :disabled="loading || !form.useCollation" />
              {{ t("mongo.createCollectionNumericOrderingHint") }}
            </label>
          </div>
        </TabsContent>
      </Tabs>

      <p v-if="formError" class="text-xs text-destructive" data-form-error>{{ formError }}</p>
      <pre v-else-if="preview" class="max-h-28 min-w-0 max-w-full shrink-0 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap" data-preview>{{ preview }}</pre>
      <p v-if="error" class="min-w-0 max-w-full overflow-x-auto text-sm text-destructive">{{ error }}</p>

      <DialogFooter>
        <Button variant="outline" :disabled="loading" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!canSubmit" @click="confirm">
          <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
          {{ t("mongo.createCollectionConfirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import type { NativeJobReferenceCatalog, NativeJobReferenceKind, NativeJobRow, NativeJobScope } from "@/lib/database/nativeJobs";

const props = defineProps<{ scope?: NativeJobScope; kind: Exclude<NativeJobReferenceKind, "program-arguments" | "destination-group-members">; disabled?: boolean }>();
const emit = defineEmits<{ select: [reference: { owner: string; name: string; metadata: NativeJobRow }] }>();
const { t } = useI18n();
const open = ref(false);
const filter = ref("");
const owner = ref("");
const offset = ref(0);
const loading = ref(false);
const failed = ref(false);
const catalog = shallowRef<NativeJobReferenceCatalog>();
const pageSize = 100;
let requestId = 0;
const scopeKey = computed(() => JSON.stringify([props.scope?.connectionId, props.scope?.database, props.scope?.contextId, props.kind]));
const rows = computed(() => (catalog.value?.objects.status === "available" || catalog.value?.objects.status === "truncated" ? catalog.value.objects.value : []));
const title = computed(() => t("nativeJobs.chooseReference", { kind: t(`nativeJobs.referenceKinds.${props.kind}`) }));

async function load(nextOffset = 0) {
  if (!props.scope || props.disabled || !open.value) return;
  const id = ++requestId;
  const key = scopeKey.value;
  loading.value = true;
  failed.value = false;
  catalog.value = undefined;
  offset.value = nextOffset;
  try {
    const result = await api.nativeJobReferences({ scope: { ...props.scope }, kind: props.kind, schema: owner.value || undefined, filter: filter.value, offset: nextOffset, limit: pageSize });
    if (id === requestId && key === scopeKey.value && open.value) catalog.value = result;
  } catch {
    if (id === requestId && key === scopeKey.value && open.value) failed.value = true;
  } finally {
    if (id === requestId) loading.value = false;
  }
}
function select(row: NativeJobRow) {
  if (loading.value || props.disabled || !props.scope || !open.value) return;
  if (typeof row.DBX_OWNER !== "string" || typeof row.DBX_NAME !== "string") return;
  emit("select", { owner: row.DBX_OWNER, name: row.DBX_NAME, metadata: row });
  open.value = false;
}
watch(
  scopeKey,
  () => {
    ++requestId;
    open.value = false;
    catalog.value = undefined;
    filter.value = "";
    owner.value = "";
    loading.value = false;
    failed.value = false;
  },
  { flush: "sync" },
);
watch(open, (value) => {
  if (value) void load();
  else {
    ++requestId;
    loading.value = false;
    catalog.value = undefined;
  }
});
</script>

<template>
  <Button type="button" variant="outline" size="sm" :disabled="disabled || !scope" @click="open = true">{{ title }}</Button>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[80vh] max-w-2xl flex-col gap-4 overflow-hidden">
      <DialogHeader
        ><DialogTitle>{{ title }}</DialogTitle></DialogHeader
      >
      <form class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" @submit.prevent="load()">
        <Input v-model="owner" :aria-label="t('nativeJobs.ownerFilter')" :placeholder="t('nativeJobs.ownerFilter')" :disabled="loading" />
        <Input v-model="filter" :aria-label="t('nativeJobs.referenceFilter')" :placeholder="t('nativeJobs.referenceFilter')" :disabled="loading" />
        <Button type="submit" variant="secondary" :disabled="loading || disabled">{{ t("common.refresh") }}</Button>
      </form>
      <p v-if="loading" role="status" class="py-6 text-center text-sm text-muted-foreground">{{ t("common.loading") }}</p>
      <p v-else-if="failed" role="alert" class="text-sm text-destructive">{{ t("damengJobAdmin.loadFailed") }}</p>
      <template v-else-if="catalog">
        <p v-if="catalog.source.source" class="text-xs text-muted-foreground">{{ catalog.source.source }} · {{ t(`nativeJobs.catalogCoverage.${catalog.source.coverage ?? "unknown"}`) }}</p>
        <p v-if="catalog.objects.status === 'empty'" role="status" class="py-6 text-center text-sm text-muted-foreground">{{ t("nativeJobs.emptyReferences") }}</p>
        <p v-else-if="catalog.objects.status !== 'available' && catalog.objects.status !== 'truncated'" role="status" class="rounded border border-amber-500/40 p-3 text-sm">{{ t("nativeJobs.referenceCatalogUnavailable", { status: catalog.objects.status }) }}</p>
        <div v-else class="min-h-0 overflow-auto rounded border" role="group" :aria-label="title">
          <button
            v-for="row in rows"
            :key="JSON.stringify([row.DBX_OWNER, row.DBX_NAME])"
            type="button"
            data-native-reference
            class="grid w-full grid-cols-[minmax(6rem,1fr)_minmax(0,2fr)] gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            :disabled="disabled"
            @click="select(row)"
          >
            <span class="break-all text-muted-foreground">{{ row.DBX_OWNER }}</span
            ><span class="break-all font-mono">{{ row.DBX_NAME }}</span>
          </button>
        </div>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="offset === 0 || loading || disabled" @click="load(Math.max(0, offset - pageSize))">{{ t("nativeJobs.previousPage") }}</Button>
          <Button type="button" variant="outline" size="sm" :disabled="catalog.objects.status !== 'truncated' || loading || disabled" @click="load(offset + pageSize)">{{ t("nativeJobs.nextPage") }}</Button>
        </div>
      </template>
    </DialogContent>
  </Dialog>
</template>

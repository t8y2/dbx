<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FileArchive, Loader2, ShieldCheck } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import type { AgentOfflineExportCandidate, AgentOfflineExportPreview, AgentOfflineExportUnavailableReason } from "@/lib/backend/api";

const props = defineProps<{
  open: boolean;
  preview: AgentOfflineExportPreview | null;
  loading?: boolean;
  exporting?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [driverKeys: string[]];
}>();

const { t } = useI18n();
const selectedDriverKeys = ref<string[]>([]);

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => {
    if (props.exporting && !value) return;
    emit("update:open", value);
  },
});

const candidates = computed(() => props.preview?.candidates ?? []);
const eligibleCandidates = computed(() => candidates.value.filter((candidate) => candidate.eligible));
const selectedCandidates = computed(() => eligibleCandidates.value.filter((candidate) => selectedDriverKeys.value.includes(candidate.dbType)));
const selectedJres = computed(() => new Set(selectedCandidates.value.map((candidate) => candidate.requiredJre).filter((jre): jre is string => Boolean(jre))));
const selectedCount = computed(() => selectedDriverKeys.value.length);
const canConfirm = computed(() => selectedCount.value > 0 && !props.loading && !props.exporting && !props.error);

watch(
  () => [props.open, props.preview] as const,
  ([open]) => {
    if (open && props.preview) {
      selectedDriverKeys.value = eligibleCandidates.value.map((candidate) => candidate.dbType);
    }
  },
  { immediate: true },
);

function isSelected(dbType: string) {
  return selectedDriverKeys.value.includes(dbType);
}

function toggle(dbType: string, checked: boolean) {
  if (checked) {
    if (!selectedDriverKeys.value.includes(dbType)) {
      selectedDriverKeys.value = [...selectedDriverKeys.value, dbType];
    }
    return;
  }
  selectedDriverKeys.value = selectedDriverKeys.value.filter((selected) => selected !== dbType);
}

function selectAll() {
  selectedDriverKeys.value = eligibleCandidates.value.map((candidate) => candidate.dbType);
}

function clearSelection() {
  selectedDriverKeys.value = [];
}

function confirm() {
  if (!canConfirm.value) return;
  emit("confirm", [...selectedDriverKeys.value]);
}

function formatSize(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function artifactLabel(candidate: AgentOfflineExportCandidate) {
  if (candidate.artifactKind === "jar") return t("driverStore.offlineExportArtifactJar");
  if (candidate.artifactKind === "native") return t("driverStore.offlineExportArtifactNative");
  return t("driverStore.offlineExportArtifactUnknown");
}

function unavailableReason(reason: AgentOfflineExportUnavailableReason | null) {
  return reason ? t(`driverStore.offlineExportUnavailable_${reason}`) : "";
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[640px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <FileArchive class="h-5 w-5" />
          {{ t("driverStore.offlineExportTitle") }}
        </DialogTitle>
      </DialogHeader>

      <div class="grid gap-3 py-2" :aria-busy="loading || exporting">
        <p class="text-sm text-muted-foreground">{{ t("driverStore.offlineExportDescription") }}</p>

        <div v-if="preview" class="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <span>
            {{ t("driverStore.offlineExportPlatform") }}
            <Badge variant="outline" class="ml-1 font-mono">{{ preview.platform }}</Badge>
          </span>
          <span class="text-muted-foreground">
            {{ t("driverStore.offlineExportSelectedCount", { selected: selectedCount, total: eligibleCandidates.length }) }}
          </span>
        </div>

        <div v-if="loading" role="status" aria-live="polite" class="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("driverStore.offlineExportPreparing") }}
        </div>
        <div v-else-if="error" role="alert" class="flex h-48 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 px-6 text-center text-sm text-destructive">
          {{ error }}
        </div>
        <template v-else>
          <div class="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" :disabled="exporting || eligibleCandidates.length === 0" @click="selectAll">
              {{ t("driverStore.offlineExportSelectAll") }}
            </Button>
            <Button type="button" variant="outline" size="sm" :disabled="exporting || selectedCount === 0" @click="clearSelection">
              {{ t("driverStore.offlineExportClear") }}
            </Button>
          </div>

          <ScrollArea class="h-72 rounded-md border">
            <div v-if="candidates.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
              {{ t("driverStore.offlineExportNoDrivers") }}
            </div>
            <label v-for="candidate in candidates" :key="candidate.dbType" class="flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0" :class="candidate.eligible ? 'cursor-pointer hover:bg-muted/50' : 'cursor-not-allowed bg-muted/20 opacity-70'">
              <input
                type="checkbox"
                class="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
                :checked="isSelected(candidate.dbType)"
                :disabled="!candidate.eligible || exporting"
                :aria-label="candidate.label"
                :aria-describedby="!candidate.eligible ? `offline-export-reason-${candidate.dbType}` : undefined"
                @change="toggle(candidate.dbType, ($event.target as HTMLInputElement).checked)"
              />
              <DatabaseIcon :db-type="candidate.dbType" class="mt-0.5 h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span class="truncate text-sm font-medium">{{ candidate.label }}</span>
                  <Badge variant="outline" class="h-5 rounded-full px-2 text-[10px]">v{{ candidate.version }}</Badge>
                  <Badge v-if="candidate.artifactKind" variant="secondary" class="h-5 rounded-full px-2 text-[10px]">{{ artifactLabel(candidate) }}</Badge>
                  <Badge v-if="candidate.requiredJre" variant="secondary" class="h-5 rounded-full px-2 text-[10px]">JRE {{ candidate.requiredJre }}</Badge>
                  <span v-if="candidate.size" class="text-[11px] text-muted-foreground">{{ formatSize(candidate.size) }}</span>
                </span>
                <span v-if="!candidate.eligible" :id="`offline-export-reason-${candidate.dbType}`" class="mt-0.5 block text-xs text-muted-foreground">
                  {{ unavailableReason(candidate.unavailableReason) }}
                </span>
              </span>
            </label>
          </ScrollArea>

          <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {{ t("driverStore.offlineExportJreSummary", { count: selectedJres.size }) }}
          </div>

          <div class="flex items-start gap-2 rounded-md border border-green-500/20 bg-green-500/5 px-3 py-2 text-xs text-muted-foreground">
            <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <span>{{ t("driverStore.offlineExportSecurityHint") }}</span>
          </div>
        </template>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" :disabled="exporting" @click="dialogOpen = false">
          {{ t("common.cancel") }}
        </Button>
        <Button type="button" :disabled="!canConfirm" @click="confirm">
          <Loader2 v-if="exporting" class="mr-1.5 h-4 w-4 animate-spin" />
          {{ exporting ? t("driverStore.offlineExporting") : t("driverStore.offlineExportStart", { count: selectedCount }) }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

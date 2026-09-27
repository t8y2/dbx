<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { setLocale, type Locale } from "@/i18n";
import { LOCALE_OPTIONS } from "@/lib/app/localeOptions";
import { saveTextFile } from "@/lib/export/saveTextFile";
import type { useMigrationStore } from "@/stores/migrationStore";

const props = defineProps<{ store: ReturnType<typeof useMigrationStore> }>();
const { t, locale } = useI18n({ useScope: "global" });
const status = computed(() => props.store.state.status);
const confirmingCleanup = ref(false);
const diagnosticText = computed(() => (props.store.state.error ? JSON.stringify(props.store.diagnostic(), null, 2) : ""));
const exportingDiagnostic = ref(false);
const canRevealPaths = computed(() => isTauriRuntime());
const errorCode = computed(() => props.store.state.errorCode);
const errorMessage = computed(() => props.store.state.errorMessage);
const errorAdviceKey = computed(() => {
  if (props.store.state.error === "cleanupFailed") return "migration.errors.cleanupAdvice";
  switch (errorCode.value) {
    case "MISSING_MANAGED_KEY":
    case "MISSING_EXTERNAL_KEY":
    case "MISSING_PERSISTENT_KEY":
      return "migration.errors.persistentKeyAdvice";
    case "ENCRYPTED_DATA_KEY_MISSING":
    case "SECRET_KEY_INVALID":
    case "SECRET_KEY_MISMATCH":
    case "KEY_FILE_UNAVAILABLE":
    case "KEY_PROVIDER_UNAVAILABLE":
      return "migration.errors.keyProviderAdvice";
    case "BACKUP_FAILED":
      return "migration.errors.backupAdvice";
    case "LEGACY_JSON_INVALID":
      return "migration.errors.jsonAdvice";
    case "VERIFICATION_FAILED":
      return "migration.errors.verifyAdvice";
    default:
      return "migration.errors.genericAdvice";
  }
});
function changeLocale(event: Event) {
  const value = (event.target as HTMLSelectElement).value as Locale;
  void setLocale(value);
}
async function exitApp() {
  if (isTauriRuntime()) {
    try {
      await api.completeAppClose("quit");
      return;
    } catch {
      /* browser fallback */
    }
  }
  window.close();
}
async function revealPath(path: string | null | undefined) {
  if (!path || !isTauriRuntime()) return;
  try {
    await api.revealPathInFileManager(path);
  } catch {
    /* the path stays visible so it can still be copied manually */
  }
}
async function diagnostic() {
  if (exportingDiagnostic.value) return;
  exportingDiagnostic.value = true;
  try {
    await saveTextFile(diagnosticText.value, "dbx-migration-diagnostic.json", "JSON", "json");
  } catch {
    // Keep a selectable, redacted report visible even if native saving fails.
  } finally {
    exportingDiagnostic.value = false;
  }
}
</script>
<template>
  <main class="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-background/95 p-4 sm:p-6" role="dialog" aria-modal="true">
    <section class="my-auto w-full max-w-2xl rounded-xl border bg-card p-8 shadow-2xl">
      <div class="mb-8 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{{ t("migration.eyebrow") }}</p>
          <h1 class="mt-2 text-2xl font-semibold">{{ t("migration.title") }}</h1>
        </div>
        <label class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span class="sr-only">{{ t("migration.language") }}</span>
          <select class="h-8 rounded-md border bg-card px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary" :value="locale" :aria-label="t('migration.language')" @change="changeLocale">
            <option v-for="option in LOCALE_OPTIONS" :key="option.value" :value="option.value">{{ option.flag }} {{ option.label }}</option>
          </select>
        </label>
      </div>
      <ol class="mb-8 grid grid-cols-3 gap-3" :aria-label="t('migration.stepsLabel')">
        <li v-for="item in [1, 2, 3]" :key="item" class="flex min-w-0 items-center justify-center gap-2 text-center text-sm">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold" :class="item <= props.store.state.step ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground'">{{ item }}</span
          ><span :class="item <= props.store.state.step ? 'font-medium' : 'text-muted-foreground'">{{ t(`migration.step${item}`) }}</span>
        </li>
      </ol>
      <div v-if="props.store.state.loading" class="py-10 text-center text-sm text-muted-foreground">{{ t("migration.checking") }}</div>
      <template v-else>
        <div v-if="props.store.state.step === 1" class="space-y-5">
          <p class="text-sm text-muted-foreground">{{ t("migration.intro") }}</p>
          <div class="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
            <h2 class="font-medium">{{ t("migration.whyTitle") }}</h2>
            <p class="mt-2 text-muted-foreground">{{ t("migration.whyBody") }}</p>
            <ul class="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{{ t("migration.whyItem1") }}</li>
              <li>{{ t("migration.whyItem2") }}</li>
            </ul>
          </div>
          <div v-if="status" class="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
            <div>
              <span class="text-muted-foreground">{{ t("migration.connectionCountLabel") }}</span> {{ status.connectionCount }}
            </div>
            <div>
              <span class="text-muted-foreground">{{ t("migration.secretCountLabel") }}</span> {{ status.databasePlaintextCount }}
            </div>
            <div>
              <span class="text-muted-foreground">{{ t("migration.backupRequiredLabel") }}</span> {{ status.backupRequired ? t("migration.yes") : t("migration.no") }}
            </div>
            <div>
              <span class="text-muted-foreground">{{ t("migration.keyProviderLabel") }}</span>
              {{ status.keyStatus === "will_create" ? t("migration.keyWillCreate") : status.persistentKeyConfigured ? t("migration.ready") : t("migration.pending") }}
            </div>
          </div>
          <p v-if="status?.dataDir" class="break-all text-xs text-muted-foreground">
            {{ t("migration.dataDir")
            }}<!--
            --><button
              type="button"
              class="break-all text-left underline decoration-dotted underline-offset-2 hover:text-foreground disabled:cursor-default disabled:no-underline"
              :disabled="!canRevealPaths"
              :title="canRevealPaths ? t('migration.openDataDir') : status.dataDir"
              @click="revealPath(status.dataDir)"
            >
              {{ status.dataDir }}
            </button>
          </p>
          <p v-if="status?.keyProviderAvailable === false && !status.keyCreationAllowed" class="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{{ t("migration.keyUnavailable") }}</p>
          <p v-else-if="status?.keyStatus === 'will_create'" class="rounded-lg bg-primary/5 p-3 text-sm text-muted-foreground">{{ t("migration.keyWillCreateHint") }}</p>
          <p v-if="status?.keyFileConfigured === false && status?.persistentKeyConfigured === false && status?.keyCreationAllowed === false" class="text-xs text-muted-foreground">{{ t("migration.keyRecoveryHint") }}</p>
          <div v-if="props.store.state.error" class="space-y-1 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            <p>{{ t(`migration.${props.store.state.error === "statusFailed" ? "statusFailed" : props.store.state.error === "cleanupFailed" ? "cleanupFailed" : "failed"}`) }}</p>
            <p v-if="errorCode">{{ t("migration.errorCode", { code: errorCode }) }}</p>
            <p v-if="errorMessage">{{ errorMessage }}</p>
            <p>{{ t(errorAdviceKey) }}</p>
          </div>
          <div class="flex flex-wrap gap-3">
            <button v-if="props.store.state.error === 'statusFailed' || (status?.keyProviderAvailable === false && !status?.keyCreationAllowed)" class="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" :disabled="props.store.state.busy" @click="props.store.initialize">
              {{ t("migration.retryStatus") }}</button
            ><button
              v-else
              class="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
              :disabled="props.store.state.busy || (status?.keyProviderAvailable === false && !status?.keyCreationAllowed)"
              @click="status?.state === 'failed' ? props.store.retry() : props.store.start()"
            >
              {{ status?.state === "failed" ? t("migration.retryMigration") : t("migration.start") }}</button
            ><button v-if="props.store.state.error" class="rounded-md border px-4 py-2" @click="diagnostic">{{ t("migration.exportDiagnostic") }}</button
            ><button v-if="props.store.state.error && status?.dataDir && canRevealPaths" class="rounded-md border px-4 py-2" @click="revealPath(status.dataDir)">{{ t("migration.openDataDir") }}</button
            ><button v-if="props.store.state.error" class="rounded-md border px-4 py-2" @click="exitApp">{{ t("migration.exit") }}</button>
          </div>
        </div>
        <div v-else-if="props.store.state.step === 2" class="space-y-5">
          <div class="rounded-lg border p-5" :class="props.store.state.error ? 'border-destructive/40' : 'border-primary/30'">
            <div class="flex items-center gap-3">
              <span class="h-3 w-3 rounded-full" :class="props.store.state.busy ? 'animate-pulse bg-primary' : 'bg-destructive'" />
              <h2 class="font-medium">{{ props.store.state.error === "statusFailed" ? t("migration.statusFailed") : props.store.state.error ? t("migration.failed") : t("migration.running") }}</h2>
            </div>
            <p v-if="errorCode" class="mt-3 text-sm">{{ t("migration.errorCode", { code: errorCode }) }}</p>
            <p v-if="errorMessage" class="mt-2 text-sm">{{ errorMessage }}</p>
            <p class="mt-3 text-sm text-muted-foreground">{{ props.store.state.error ? t(errorAdviceKey) : t("migration.progress") }}</p>
          </div>
          <div v-if="props.store.state.error" class="flex flex-wrap gap-3">
            <button class="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" :disabled="props.store.state.busy" @click="props.store.state.error === 'statusFailed' ? props.store.initialize() : props.store.retry()">
              {{ props.store.state.busy ? t("migration.running") : props.store.state.error === "statusFailed" ? t("migration.retryStatus") : t("migration.retryMigration") }}</button
            ><button class="rounded-md border px-4 py-2 disabled:opacity-50" :disabled="props.store.state.busy" @click="diagnostic">{{ t("migration.exportDiagnostic") }}</button
            ><button class="rounded-md border px-4 py-2 disabled:opacity-50" :disabled="props.store.state.busy" @click="exitApp">{{ t("migration.exit") }}</button>
          </div>
        </div>
        <div v-else class="space-y-5">
          <div class="rounded-lg border border-primary/30 bg-primary/5 p-5">
            <h2 class="font-medium">{{ t("migration.successTitle") }}</h2>
            <p class="mt-2 text-sm text-muted-foreground">{{ t("migration.successIntro") }}</p>
            <p v-if="status?.backupPath" class="mt-3 break-all text-xs text-muted-foreground">
              {{ t("migration.backupPath")
              }}<!--
              --><button
                type="button"
                class="break-all text-left underline decoration-dotted underline-offset-2 hover:text-foreground disabled:cursor-default disabled:no-underline"
                :disabled="!canRevealPaths"
                :title="canRevealPaths ? t('migration.openBackupDir') : status.backupPath"
                @click="revealPath(status.backupPath)"
              >
                {{ status.backupPath }}
              </button>
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button class="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" :disabled="props.store.state.busy" @click="props.store.enter">{{ t("migration.enter") }}</button
            ><button v-if="status?.backupPath && props.store.state.error !== 'cleanupFailed'" class="text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive disabled:opacity-50" :disabled="props.store.state.busy" @click="confirmingCleanup = true">
              {{ t("migration.deleteBackup") }}
            </button>
          </div>
          <div v-if="confirmingCleanup" class="rounded border p-4 text-sm">
            <p>{{ t("migration.confirmDelete") }}</p>
            <div class="mt-3 flex gap-2">
              <button
                class="rounded border border-destructive bg-card px-3 py-1 text-destructive hover:bg-destructive/10"
                @click="
                  confirmingCleanup = false;
                  props.store.cleanup();
                "
              >
                {{ t("migration.confirm") }}</button
              ><button class="rounded border px-3 py-1" @click="confirmingCleanup = false">{{ t("migration.cancel") }}</button>
            </div>
          </div>
          <div v-if="props.store.state.error === 'cleanupFailed'" class="space-y-3" role="alert">
            <p class="text-sm text-destructive">{{ t("migration.cleanupFailed") }} {{ t("migration.errors.cleanupAdvice") }}</p>
            <button class="rounded-md border px-4 py-2 disabled:opacity-50" :disabled="props.store.state.busy" @click="props.store.cleanup">{{ t("migration.retryCleanup") }}</button>
          </div>
        </div>
        <div v-if="diagnosticText" class="mt-4 space-y-2">
          <p class="text-sm font-medium">{{ t("migration.exportDiagnostic") }}</p>
          <textarea readonly :value="diagnosticText" :aria-label="t('migration.exportDiagnostic')" class="h-40 w-full rounded border bg-background p-3 font-mono text-xs" />
        </div>
      </template>
    </section>
  </main>
</template>

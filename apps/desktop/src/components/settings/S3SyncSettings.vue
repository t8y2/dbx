<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Cloud, Download, Loader2, Upload, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { forgetS3SavedCredentials, s3CredentialsStatus, s3SyncDownload, s3SyncTest, s3SyncUpload, saveS3SavedCredentials, type S3SyncConfig } from "@/lib/backend/api";
import { DEFAULT_S3_AUTO_UPLOAD_INTERVAL_MINUTES, DEFAULT_S3_OBJECT_KEY, DEFAULT_S3_REGION, normalizedS3AutoUploadInterval, readS3AutoUploadConfig, writeS3AutoUploadFields } from "@/lib/s3/s3AutoUploadConfig";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import SyncDownloadConfirmDialog from "./SyncDownloadConfirmDialog.vue";

const props = defineProps<{
  syncSecretsEnabled: boolean;
  secretsPassphrase: string;
  prepareSyncSecrets: () => Promise<void>;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const savedSqlStore = useSavedSqlStore();
const settingsStore = useSettingsStore();
const tunnelProfileStore = useTunnelProfileStore();
const stored = readS3AutoUploadConfig();
const initial = stored.s3Config;

const endpoint = ref(initial?.endpoint || "");
const region = ref(initial?.region || DEFAULT_S3_REGION);
const bucket = ref(initial?.bucket || "");
const accessKeyId = ref(initial?.accessKeyId || "");
const secretAccessKey = ref("");
const sessionToken = ref("");
const objectKey = ref(initial?.objectKey || DEFAULT_S3_OBJECT_KEY);
const addressingStyle = ref<"path" | "virtualHosted">(initial?.addressingStyle || (initial?.endpoint ? "path" : "virtualHosted"));
const rememberCredentials = ref(false);
const hasSavedCredentials = ref(false);
const autoUploadEnabled = ref(stored.enabled);
const autoUploadIntervalMinutes = ref(stored.intervalMinutes || DEFAULT_S3_AUTO_UPLOAD_INTERVAL_MINUTES);
const busy = ref<"" | "test" | "upload" | "download">("");
const message = ref("");
const error = ref(false);
const downloadConfirmOpen = ref(false);

const accountReady = computed(() => !!bucket.value.trim() && !!accessKeyId.value.trim());
const ready = computed(() => accountReady.value && !!region.value.trim() && !!objectKey.value.trim() && !busy.value && (hasSavedCredentials.value || !!secretAccessKey.value.trim()));

function currentConfig(includeCredentials = true): S3SyncConfig {
  return {
    endpoint: endpoint.value.trim() || undefined,
    region: region.value.trim() || DEFAULT_S3_REGION,
    bucket: bucket.value.trim(),
    accessKeyId: accessKeyId.value.trim() || undefined,
    secretAccessKey: includeCredentials ? secretAccessKey.value || undefined : undefined,
    sessionToken: includeCredentials ? sessionToken.value.trim() || undefined : undefined,
    objectKey: objectKey.value.trim() || DEFAULT_S3_OBJECT_KEY,
    addressingStyle: addressingStyle.value,
  };
}

function rememberFields() {
  writeS3AutoUploadFields(currentConfig(false), {
    enabled: autoUploadEnabled.value,
    intervalMinutes: autoUploadIntervalMinutes.value,
  });
  window.dispatchEvent(new Event("dbx:s3-auto-upload-config-changed"));
}

function setResult(value: string, isError = false) {
  message.value = value;
  error.value = isError;
}

async function refreshCredentialsStatus() {
  if (!accountReady.value) {
    hasSavedCredentials.value = false;
    rememberCredentials.value = false;
    return;
  }
  try {
    const status = await s3CredentialsStatus(currentConfig(false));
    hasSavedCredentials.value = status.hasSavedCredentials;
    if (status.hasSavedCredentials) rememberCredentials.value = true;
  } catch {
    hasSavedCredentials.value = false;
  }
}

async function applyCredentialPreference() {
  if (rememberCredentials.value && secretAccessKey.value) {
    await saveS3SavedCredentials(currentConfig(false), secretAccessKey.value, sessionToken.value.trim() || undefined);
    hasSavedCredentials.value = true;
    secretAccessKey.value = "";
    sessionToken.value = "";
  } else if (!rememberCredentials.value && hasSavedCredentials.value) {
    await forgetS3SavedCredentials(currentConfig(false));
    hasSavedCredentials.value = false;
  }
  if (autoUploadEnabled.value && !hasSavedCredentials.value) {
    throw new Error(t("settings.syncS3AutoUploadCredentialsRequired"));
  }
}

async function clearSavedCredentials() {
  try {
    await forgetS3SavedCredentials(currentConfig(false));
    hasSavedCredentials.value = false;
    rememberCredentials.value = false;
    autoUploadEnabled.value = false;
    secretAccessKey.value = "";
    sessionToken.value = "";
    rememberFields();
  } catch (cause: any) {
    setResult(cause?.message || String(cause), true);
  }
}

async function runAction(kind: "test" | "upload" | "download", action: (passphrase?: string) => Promise<string>) {
  busy.value = kind;
  message.value = "";
  error.value = false;
  const passphrase = props.syncSecretsEnabled ? props.secretsPassphrase.trim() || undefined : undefined;
  try {
    rememberFields();
    await applyCredentialPreference();
    if (kind !== "test") await props.prepareSyncSecrets();
    setResult(await action(passphrase));
  } catch (cause: any) {
    setResult(cause?.message || String(cause), true);
  } finally {
    busy.value = "";
  }
}

async function testConnection() {
  await runAction("test", async () => {
    await s3SyncTest(currentConfig());
    return t("settings.syncS3TestSuccess");
  });
}

async function uploadSnapshot() {
  await runAction("upload", async (passphrase) => {
    const summary = await s3SyncUpload(currentConfig(), settingsStore.editorSettings, passphrase);
    return t("settings.syncS3UploadSuccess", { bytes: summary.bytes, bucket: summary.bucket, key: summary.objectKey });
  });
}

function requestDownloadSnapshot() {
  downloadConfirmOpen.value = true;
}

async function downloadSnapshot() {
  await runAction("download", async (passphrase) => {
    const result = await s3SyncDownload(currentConfig(), passphrase);
    if (result.editorSettings && typeof result.editorSettings === "object") {
      settingsStore.updateEditorSettings(result.editorSettings as any);
    }
    await settingsStore.updateDesktopSettings(result.desktopSettings);
    await connectionStore.initFromDisk();
    await savedSqlStore.initFromStorage();
    await tunnelProfileStore.refresh();
    await settingsStore.reloadAiConfigs();
    let resultMessage = t("settings.syncS3DownloadSuccess", {
      bytes: result.summary.bytes,
      bucket: result.summary.bucket,
      key: result.summary.objectKey,
    });
    if (result.applySummary.encryptedSecretsPresent && !result.applySummary.secretsApplied) {
      resultMessage += ` ${t("settings.syncSecretsSkipped")}`;
    }
    if (result.applySummary.secretsApplied) resultMessage += ` ${t("settings.syncSecretsApplied")}`;
    return resultMessage;
  });
}

watch(
  () => [endpoint.value, region.value, bucket.value, accessKeyId.value],
  () => void refreshCredentialsStatus(),
);

watch(endpoint, (value, previous) => {
  if (!previous.trim() && value.trim()) addressingStyle.value = "path";
  if (previous.trim() && !value.trim()) addressingStyle.value = "virtualHosted";
});

watch([autoUploadEnabled, autoUploadIntervalMinutes], () => {
  autoUploadIntervalMinutes.value = normalizedS3AutoUploadInterval(autoUploadIntervalMinutes.value);
  rememberFields();
});

onMounted(() => void refreshCredentialsStatus());
</script>

<template>
  <div class="space-y-5">
    <div class="space-y-1">
      <div class="flex items-center gap-2 text-sm font-medium">
        <Cloud class="h-4 w-4 text-muted-foreground" />
        {{ t("settings.syncS3Title") }}
      </div>
      <p class="text-xs text-muted-foreground">{{ t("settings.syncS3Description") }}</p>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <div class="space-y-2 md:col-span-2">
        <Label for="s3-addressing-style">{{ t("settings.syncS3AddressingStyle") }}</Label>
        <Select v-model="addressingStyle">
          <SelectTrigger id="s3-addressing-style" class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="path">{{ t("settings.syncS3AddressingPathStyle") }}</SelectItem>
            <SelectItem value="virtualHosted">{{ t("settings.syncS3AddressingVirtualHostedStyle") }}</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ t("settings.syncS3AddressingStyleDescription") }}</p>
      </div>
      <div class="space-y-2 md:col-span-2">
        <Label for="s3-endpoint">{{ t("settings.syncS3Endpoint") }}</Label>
        <Input id="s3-endpoint" v-model="endpoint" autocomplete="off" placeholder="https://s3.example.com" />
        <p class="text-xs text-muted-foreground">{{ t("settings.syncS3EndpointDescription") }}</p>
      </div>
      <div class="space-y-2">
        <Label for="s3-region">{{ t("settings.syncS3Region") }}</Label>
        <Input id="s3-region" v-model="region" autocomplete="off" />
      </div>
      <div class="space-y-2">
        <Label for="s3-bucket">{{ t("settings.syncS3Bucket") }}</Label>
        <Input id="s3-bucket" v-model="bucket" autocomplete="off" />
      </div>
      <div class="space-y-2 md:col-span-2">
        <Label for="s3-object-key">{{ t("settings.syncS3ObjectKey") }}</Label>
        <Input id="s3-object-key" v-model="objectKey" autocomplete="off" />
      </div>
      <div class="space-y-2 md:col-span-2">
        <Label for="s3-access-key-id">{{ t("settings.syncS3AccessKeyId") }}</Label>
        <Input id="s3-access-key-id" v-model="accessKeyId" autocomplete="off" />
      </div>
      <div class="space-y-2">
        <Label for="s3-secret-access-key">{{ t("settings.syncS3SecretAccessKey") }}</Label>
        <div class="relative">
          <PasswordInput id="s3-secret-access-key" v-model="secretAccessKey" :placeholder="hasSavedCredentials ? '••••••••' : ''" :disabled="hasSavedCredentials" :show-toggle="!hasSavedCredentials" autocomplete="off" />
          <Button v-if="hasSavedCredentials" type="button" variant="ghost" size="icon" class="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" :title="t('settings.syncClearSavedPassword')" @click="clearSavedCredentials">
            <X class="size-3.5" />
          </Button>
        </div>
      </div>
      <div class="space-y-2">
        <Label for="s3-session-token">{{ t("settings.syncS3SessionToken") }}</Label>
        <PasswordInput id="s3-session-token" v-model="sessionToken" :disabled="hasSavedCredentials" :show-toggle="!hasSavedCredentials" autocomplete="off" />
      </div>
      <label class="flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
        <input v-model="rememberCredentials" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" />
        <span>{{ t("settings.syncS3RememberCredentials") }}</span>
      </label>
      <div class="space-y-2 rounded-md border bg-muted/20 px-3 py-3 md:col-span-2">
        <label class="flex items-center gap-2 text-xs">
          <input v-model="autoUploadEnabled" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" />
          <span class="font-medium">{{ t("settings.syncAutoUpload") }}</span>
        </label>
        <div class="flex items-center gap-2">
          <Label for="s3-auto-upload-interval" class="text-xs text-muted-foreground">{{ t("settings.syncAutoUploadInterval") }}</Label>
          <Input id="s3-auto-upload-interval" v-model.number="autoUploadIntervalMinutes" type="number" min="1" max="1440" step="1" class="h-7 w-24 text-xs" :disabled="!autoUploadEnabled" />
          <span class="text-xs text-muted-foreground">{{ t("settings.syncAutoUploadMinutes") }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("settings.syncS3AutoUploadDescription") }}</p>
      </div>
    </div>

    <div v-if="message" class="text-xs" :class="error ? 'text-destructive' : 'text-green-600 dark:text-green-400'">
      {{ message }}
    </div>
    <div class="flex flex-wrap justify-end gap-2">
      <Button variant="outline" size="sm" :disabled="!ready" @click="testConnection">
        <Loader2 v-if="busy === 'test'" class="mr-1 h-3 w-3 animate-spin" />
        {{ t("settings.syncTest") }}
      </Button>
      <Button variant="outline" size="sm" :disabled="!ready" @click="requestDownloadSnapshot">
        <Loader2 v-if="busy === 'download'" class="mr-1 h-3 w-3 animate-spin" />
        <Download v-else class="mr-1 h-3 w-3" />
        {{ t("settings.syncDownload") }}
      </Button>
      <Button size="sm" :disabled="!ready" @click="uploadSnapshot">
        <Loader2 v-if="busy === 'upload'" class="mr-1 h-3 w-3 animate-spin" />
        <Upload v-else class="mr-1 h-3 w-3" />
        {{ t("settings.syncUpload") }}
      </Button>
    </div>
    <SyncDownloadConfirmDialog v-model:open="downloadConfirmOpen" @confirm="downloadSnapshot" />
  </div>
</template>

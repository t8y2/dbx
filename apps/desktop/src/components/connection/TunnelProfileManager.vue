<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, Trash2 } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { createTunnelProfile, createTunnelProfileTestGuard, tunnelProfileSummary, type TunnelProfileType } from "@/lib/connection/tunnelProfiles";
import { applySshConfigHostAliasPrefill as prefillSshConfigHostAlias } from "@/lib/connection/sshConfigHosts";
import * as api from "@/lib/backend/api";
import type { SshConfigHostEntry, TunnelProfile } from "@/types/database";
import { translateBackendError } from "@/i18n/backend-errors";

const { t } = useI18n();
const { toast } = useToast();
const store = useTunnelProfileStore();

const draft = ref<TunnelProfile[]>([]);
const selectedId = ref<string | null>(null);
const isSaving = ref(false);
const hasInitializedDraft = ref(false);
const isTesting = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);
const testGuard = createTunnelProfileTestGuard();
const sshConfigHosts = ref<SshConfigHostEntry[]>([]);

function cloneProfiles(profiles: TunnelProfile[]): TunnelProfile[] {
  return JSON.parse(JSON.stringify(profiles)) as TunnelProfile[];
}

function resetDraft() {
  draft.value = cloneProfiles(store.profiles);
  if (!draft.value.some((profile) => profile.id === selectedId.value)) {
    selectedId.value = draft.value[0]?.id || null;
  }
}

const isDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(store.profiles));

void store.init();
watch(
  () => store.isLoaded,
  (loaded) => {
    // A remounted settings panel starts with an empty draft even when Pinia
    // already contains profiles, so the initial empty state is not a user edit.
    if (loaded && (!hasInitializedDraft.value || !isDirty.value)) {
      resetDraft();
      hasInitializedDraft.value = true;
    }
  },
  { immediate: true },
);

const selected = computed(() => draft.value.find((profile) => profile.id === selectedId.value) || null);
const selectedSsh = computed(() => (selected.value?.type === "ssh" ? selected.value : null));
const selectedProxy = computed(() => (selected.value?.type === "proxy" ? selected.value : null));
const selectedHttp = computed(() => (selected.value?.type === "http_tunnel" ? selected.value : null));
const sshConfigHostAliases = computed(() => sshConfigHosts.value.map((entry) => entry.alias));

async function loadSshConfigHosts() {
  try {
    sshConfigHosts.value = await api.listSshConfigHosts();
  } catch {
    sshConfigHosts.value = [];
  }
}

function updateSelectedSshHost(value: string | number) {
  if (!selectedSsh.value) return;
  selectedSsh.value.host = String(value);
  prefillSshConfigHostAlias(selectedSsh.value, sshConfigHosts.value);
}

void loadSshConfigHosts();

function invalidateProfileTest() {
  testGuard.invalidate();
  isTesting.value = false;
  testResult.value = null;
}

// Profile tests are asynchronous, so any selection or configuration change
// must invalidate the request before it can publish a stale result.
watch(
  [selectedId, selectedSsh, selectedProxy],
  () => {
    invalidateProfileTest();
  },
  { deep: true },
);

function profileTypeLabel(profile: TunnelProfile): string {
  if (profile.type === "proxy") return "Proxy";
  if (profile.type === "http_tunnel") return t("connection.httpTunnel");
  return "SSH";
}

function profileDisplayName(profile: TunnelProfile): string {
  return profile.name?.trim() || tunnelProfileSummary(profile) || t("settings.tunnelsUnnamedProfile");
}

function addProfile(type: TunnelProfileType) {
  const profile = createTunnelProfile(type);
  draft.value = [...draft.value, profile];
  selectedId.value = profile.id;
}

function removeSelected() {
  const current = selected.value;
  if (!current) return;
  draft.value = draft.value.filter((profile) => profile.id !== current.id);
  selectedId.value = draft.value[0]?.id || null;
}

function updateSshAuthMethod(value: unknown) {
  const profile = selectedSsh.value;
  if (!profile) return;
  profile.auth_method = value === "key" ? "key" : value === "none" ? "none" : "password";
  if (profile.auth_method !== "password") profile.password = "";
  if (profile.auth_method !== "key") {
    profile.key_path = "";
    profile.key_passphrase = "";
  }
}

function updateProxyType(value: unknown) {
  const profile = selectedProxy.value;
  if (!profile) return;
  profile.proxy_type = value === "http" ? "http" : "socks5";
}

async function save() {
  if (isSaving.value) return;
  invalidateProfileTest();
  isSaving.value = true;
  try {
    await store.saveProfiles(cloneProfiles(draft.value));
    toast(t("settings.tunnelsSaved"));
  } catch (error) {
    toast(t("settings.tunnelsSaveFailed", { message: translateBackendError(t, String(error)) }), 5000);
  } finally {
    isSaving.value = false;
  }
}

async function testSelected() {
  const profile = selectedSsh.value || selectedProxy.value;
  if (!profile || isTesting.value) return;
  const profileSnapshot = cloneProfiles([profile])[0];
  const requestId = testGuard.start(profileSnapshot);
  isTesting.value = true;
  testResult.value = null;
  try {
    const message = await store.testProfile(profileSnapshot);
    if (!testGuard.isCurrent(requestId, profile)) return;
    testResult.value = { ok: true, message: message ? t("settings.tunnelsTestSuccess") + ": " + message : t("settings.tunnelsTestSuccess") };
  } catch (error) {
    if (!testGuard.isCurrent(requestId, profile)) return;
    testResult.value = { ok: false, message: t("settings.tunnelsTestFailed", { message: translateBackendError(t, String(error)) }) };
  } finally {
    if (testGuard.isCurrent(requestId, selectedSsh.value || selectedProxy.value)) isTesting.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-xs text-muted-foreground">{{ t("settings.tunnelsDescription") }}</p>

    <div class="grid min-w-0 gap-2">
      <p v-if="!draft.length" class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
        {{ t("settings.tunnelsEmpty") }}
      </p>
      <button v-for="profile in draft" :key="profile.id" type="button" class="flex min-h-10 items-center gap-2 rounded-md border px-3 text-left text-xs transition-colors" :class="profile.id === selectedId ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'" @click="selectedId = profile.id">
        <span class="shrink-0 rounded border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{{ profileTypeLabel(profile) }}</span>
        <span class="min-w-0 flex-1 truncate">{{ profileDisplayName(profile) }}</span>
        <span class="min-w-0 truncate text-muted-foreground">{{ tunnelProfileSummary(profile) }}</span>
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" @click="addProfile('ssh')">
        <Plus class="mr-1.5 h-3.5 w-3.5" />
        {{ t("settings.tunnelsAddSsh") }}
      </Button>
      <Button type="button" variant="outline" size="sm" @click="addProfile('proxy')">
        <Plus class="mr-1.5 h-3.5 w-3.5" />
        {{ t("settings.tunnelsAddProxy") }}
      </Button>
      <Button type="button" variant="outline" size="sm" @click="addProfile('http_tunnel')">
        <Plus class="mr-1.5 h-3.5 w-3.5" />
        {{ t("settings.tunnelsAddHttp") }}
      </Button>
      <Button v-if="selected" type="button" variant="outline" size="sm" @click="removeSelected">
        <Trash2 class="mr-1.5 h-3.5 w-3.5" />
        {{ t("settings.tunnelsDelete") }}
      </Button>
    </div>

    <template v-if="selected">
      <div class="grid grid-cols-4 items-center gap-4">
        <Label class="text-xs">{{ t("settings.tunnelsProfileName") }}</Label>
        <Input v-model="selected.name" class="col-span-3" :placeholder="t('settings.tunnelsProfileNamePlaceholder')" />
      </div>

      <template v-if="selectedSsh">
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.sshHost") }}</Label>
          <Input :model-value="selectedSsh.host" class="col-span-2" list="tunnel-profile-ssh-config-host-aliases" :placeholder="t('connection.sshHostPlaceholder')" @update:model-value="updateSelectedSshHost" />
          <datalist id="tunnel-profile-ssh-config-host-aliases">
            <option v-for="alias in sshConfigHostAliases" :key="alias" :value="alias" />
          </datalist>
          <Input v-model.number="selectedSsh.port" type="number" min="1" max="65535" class="col-span-1" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.sshUser") }}</Label>
          <Input v-model="selectedSsh.user" class="col-span-3" placeholder="root" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.sshAuthMethod") }}</Label>
          <Select :model-value="selectedSsh.auth_method || 'password'" @update:model-value="updateSshAuthMethod">
            <SelectTrigger class="col-span-3 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">{{ t("connection.sshAuthMethodPassword") }}</SelectItem>
              <SelectItem value="key">{{ t("connection.sshAuthMethodKey") }}</SelectItem>
              <SelectItem value="none">{{ t("connection.sshAuthMethodNone") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="!selectedSsh.auth_method || selectedSsh.auth_method === 'password'" class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.sshPassword") }}</Label>
          <PasswordInput v-model="selectedSsh.password" class="col-span-3" :placeholder="t('connection.sshPasswordPlaceholder')" />
        </div>
        <div v-if="selectedSsh.auth_method === 'key'" class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.sshKeyPath") }}</Label>
          <Input v-model="selectedSsh.key_path" class="col-span-3" placeholder="~/.ssh/id_rsa" />
        </div>
        <div v-if="selectedSsh.auth_method === 'key'" class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.sshKeyPassphrase") }}</Label>
          <PasswordInput v-model="selectedSsh.key_passphrase" class="col-span-3" :placeholder="t('connection.sshKeyPassphrasePlaceholder')" />
        </div>
        <div v-if="selectedSsh.auth_method === 'none'" class="grid grid-cols-4 items-center gap-4">
          <span />
          <p class="col-span-3 text-xs text-muted-foreground">{{ t("connection.sshAuthMethodNoneHint") }}</p>
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <span />
          <label class="col-span-3 flex cursor-pointer items-center gap-2">
            <input v-model="selectedSsh.expose_lan" type="checkbox" class="mr-0" />
            <span class="text-xs text-muted-foreground">{{ t("connection.sshExposeLan") }}</span>
          </label>
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.sshConnectTimeout") }}</Label>
          <Input v-model.number="selectedSsh.connect_timeout_secs" type="number" min="1" max="300" step="1" class="col-span-3" />
        </div>
      </template>

      <template v-else-if="selectedProxy">
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.proxyType") }}</Label>
          <Select :model-value="selectedProxy.proxy_type || 'socks5'" @update:model-value="updateProxyType">
            <SelectTrigger class="col-span-3 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="socks5">SOCKS5</SelectItem>
              <SelectItem value="http">HTTP CONNECT</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.proxyHost") }}</Label>
          <Input v-model="selectedProxy.host" class="col-span-2" placeholder="127.0.0.1" />
          <Input v-model.number="selectedProxy.port" type="number" class="col-span-1" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.proxyUsername") }}</Label>
          <Input v-model="selectedProxy.username" class="col-span-3" :placeholder="t('connection.proxyUsernamePlaceholder')" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.proxyPassword") }}</Label>
          <PasswordInput v-model="selectedProxy.password" class="col-span-3" :placeholder="t('connection.proxyPasswordPlaceholder')" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.proxyTestTarget") }}</Label>
          <Input v-model="selectedProxy.test_target" class="col-span-3" :placeholder="t('connection.proxyTestTargetPlaceholder')" />
        </div>
      </template>

      <template v-else-if="selectedHttp">
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.httpTunnelUrl") }}</Label>
          <Input v-model="selectedHttp.url" class="col-span-3" placeholder="https://dbx.example.com/dbx_tunnel.php" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.httpTunnelToken") }}</Label>
          <PasswordInput v-model="selectedHttp.token" class="col-span-3" :placeholder="t('connection.httpTunnelTokenPlaceholder')" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-xs">{{ t("connection.httpTunnelConnectTimeout") }}</Label>
          <Input v-model.number="selectedHttp.connect_timeout_secs" type="number" min="1" max="300" step="1" class="col-span-3" />
        </div>
      </template>
    </template>

    <div class="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" :disabled="!isDirty || isSaving" @click="save">
        <Loader2 v-if="isSaving" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
        {{ t("settings.tunnelsSave") }}
      </Button>
      <Button type="button" variant="outline" size="sm" :disabled="!isDirty || isSaving" @click="resetDraft">
        {{ t("settings.tunnelsReset") }}
      </Button>
      <Button v-if="selectedSsh || selectedProxy" type="button" variant="outline" size="sm" :disabled="isTesting || isSaving || (!selectedSsh?.host?.trim() && !selectedProxy?.host?.trim())" @click="testSelected">
        <Loader2 v-if="isTesting" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
        {{ isTesting ? t("settings.tunnelsTesting") : t("settings.tunnelsTest") }}
      </Button>
      <p v-if="isDirty" class="text-xs text-muted-foreground">{{ t("settings.tunnelsUnsavedHint") }}</p>
    </div>

    <p v-if="testResult" class="text-xs" :class="testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">
      {{ testResult.message }}
    </p>
  </div>
</template>

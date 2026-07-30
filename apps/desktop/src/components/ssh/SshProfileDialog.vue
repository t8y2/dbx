<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CircleCheck, FolderOpen, LoaderCircle } from "@lucide/vue";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { listSshTerminalDrivers, saveSshProfile, testSshTerminalProfile } from "@/lib/backend/ssh-terminal-tauri";
import { uuid } from "@/lib/common/utils";
import type { SshAuthMethod, SshProfile, SshTerminalDriverManifest } from "@/types/ssh";

const props = defineProps<{
  open: boolean;
  profile?: SshProfile | null;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [profile: SshProfile];
}>();

const { t } = useI18n();
const drivers = ref<SshTerminalDriverManifest[]>([]);
const saving = ref(false);
const testing = ref(false);
const testSuccess = ref(false);
const error = ref("");
const draft = ref<SshProfile>(newProfile());

const authOptions = computed<Array<{ value: SshAuthMethod; label: string }>>(() => [
  { value: "agent", label: t("sshTerminal.authAgent") },
  { value: "password", label: t("sshTerminal.authPassword") },
  { value: "key", label: t("sshTerminal.authKey") },
  { value: "key+password", label: t("sshTerminal.authKeyPassword") },
  { value: "none", label: t("sshTerminal.authNone") },
]);

const showPassword = computed(() => draft.value.authMethod === "password" || draft.value.authMethod === "key+password");
const showKey = computed(() => draft.value.authMethod === "key" || draft.value.authMethod === "key+password");
const showAgent = computed(() => draft.value.authMethod === "agent");
const canSave = computed(() => {
  if (!draft.value.name.trim() || !draft.value.host.trim() || !draft.value.username.trim()) return false;
  if (!Number.isInteger(Number(draft.value.port)) || Number(draft.value.port) < 1 || Number(draft.value.port) > 65_535) return false;
  if (showPassword.value && !draft.value.password) return false;
  if (showKey.value && !draft.value.keyPath.trim()) return false;
  return true;
});

function newProfile(): SshProfile {
  return {
    id: uuid(),
    name: "",
    driverId: "builtin-russh",
    host: "",
    port: 22,
    username: "",
    authMethod: "password",
    password: "",
    keyPath: "",
    keyPassphrase: "",
    sshAgentSockPath: "",
    connectTimeoutSecs: 10,
    terminalType: "xterm-256color",
  };
}

function cloneProfile(profile: SshProfile): SshProfile {
  return JSON.parse(JSON.stringify(profile)) as SshProfile;
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    error.value = "";
    testSuccess.value = false;
    draft.value = props.profile ? cloneProfile(props.profile) : newProfile();
    try {
      drivers.value = await listSshTerminalDrivers();
      if (!drivers.value.some((driver) => driver.id === draft.value.driverId) && drivers.value[0]) {
        draft.value.driverId = drivers.value[0].id;
      }
    } catch (loadError) {
      error.value = String(loadError);
    }
  },
  { immediate: true },
);

function close() {
  if (!saving.value && !testing.value) emit("update:open", false);
}

async function chooseKeyPath() {
  const path = await openFileDialog({ multiple: false, directory: false });
  if (typeof path === "string") draft.value.keyPath = path;
}

function normalizedDraft(): SshProfile {
  return {
    ...draft.value,
    name: draft.value.name.trim(),
    host: draft.value.host.trim(),
    port: Number(draft.value.port),
    username: draft.value.username.trim(),
    keyPath: draft.value.keyPath.trim(),
    sshAgentSockPath: draft.value.sshAgentSockPath.trim(),
    connectTimeoutSecs: Number(draft.value.connectTimeoutSecs),
    terminalType: draft.value.terminalType.trim(),
  };
}

async function testConnection() {
  if (!canSave.value || testing.value || saving.value) return;
  testing.value = true;
  testSuccess.value = false;
  error.value = "";
  try {
    await testSshTerminalProfile(normalizedDraft());
    testSuccess.value = true;
  } catch (testError) {
    error.value = testError instanceof Error ? testError.message : String(testError);
  } finally {
    testing.value = false;
  }
}

async function save() {
  if (!canSave.value || saving.value || testing.value) return;
  saving.value = true;
  error.value = "";
  try {
    const saved = await saveSshProfile(normalizedDraft());
    emit("saved", saved);
    emit("update:open", false);
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => (value ? undefined : close())">
    <DialogContent class="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ profile ? t("sshTerminal.editProfile") : t("sshTerminal.newProfile") }}</DialogTitle>
      </DialogHeader>

      <div class="grid grid-cols-2 gap-x-3 gap-y-3">
        <div class="col-span-2 space-y-1.5">
          <Label for="ssh-profile-name">{{ t("sshTerminal.profileName") }}</Label>
          <Input id="ssh-profile-name" v-model="draft.name" autofocus />
        </div>

        <div class="space-y-1.5">
          <Label for="ssh-profile-host">{{ t("sshTerminal.host") }}</Label>
          <Input id="ssh-profile-host" v-model="draft.host" />
        </div>
        <div class="space-y-1.5">
          <Label for="ssh-profile-port">{{ t("sshTerminal.port") }}</Label>
          <Input id="ssh-profile-port" v-model="draft.port" type="number" min="1" max="65535" />
        </div>

        <div class="space-y-1.5">
          <Label for="ssh-profile-username">{{ t("sshTerminal.username") }}</Label>
          <Input id="ssh-profile-username" v-model="draft.username" />
        </div>
        <div class="space-y-1.5">
          <Label>{{ t("sshTerminal.authentication") }}</Label>
          <Select :model-value="draft.authMethod" @update:model-value="(value: any) => (draft.authMethod = value as SshAuthMethod)">
            <SelectTrigger class="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in authOptions" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div v-if="showPassword" class="col-span-2 space-y-1.5">
          <Label for="ssh-profile-password">{{ t("sshTerminal.password") }}</Label>
          <Input id="ssh-profile-password" v-model="draft.password" type="password" autocomplete="new-password" />
        </div>

        <div v-if="showKey" class="col-span-2 space-y-1.5">
          <Label for="ssh-profile-key-path">{{ t("sshTerminal.privateKey") }}</Label>
          <div class="flex gap-1.5">
            <Input id="ssh-profile-key-path" v-model="draft.keyPath" class="font-mono text-xs" />
            <LightTooltip :text="t('sshTerminal.choosePrivateKey')" side="bottom" :delay="0" nowrap>
              <Button variant="outline" size="icon" class="h-8 w-8 shrink-0" @click="chooseKeyPath"><FolderOpen class="h-4 w-4" /></Button>
            </LightTooltip>
          </div>
        </div>

        <div v-if="showKey" class="col-span-2 space-y-1.5">
          <Label for="ssh-profile-key-passphrase">{{ t("sshTerminal.keyPassphrase") }}</Label>
          <Input id="ssh-profile-key-passphrase" v-model="draft.keyPassphrase" type="password" autocomplete="new-password" />
        </div>

        <div v-if="showAgent" class="col-span-2 space-y-1.5">
          <Label for="ssh-profile-agent-socket">{{ t("sshTerminal.agentSocket") }}</Label>
          <Input id="ssh-profile-agent-socket" v-model="draft.sshAgentSockPath" class="font-mono text-xs" />
        </div>

        <div v-if="drivers.length > 1" class="space-y-1.5">
          <Label>{{ t("sshTerminal.driver") }}</Label>
          <Select :model-value="draft.driverId" @update:model-value="(value: any) => (draft.driverId = String(value))">
            <SelectTrigger class="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="driver in drivers" :key="driver.id" :value="driver.id">{{ driver.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="space-y-1.5" :class="drivers.length > 1 ? '' : 'col-span-2'">
          <Label for="ssh-profile-terminal-type">{{ t("sshTerminal.terminalType") }}</Label>
          <Input id="ssh-profile-terminal-type" v-model="draft.terminalType" class="font-mono text-xs" />
        </div>

        <p v-if="error" class="col-span-2 break-words text-xs text-destructive">{{ error }}</p>
        <p v-else-if="testSuccess" class="col-span-2 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CircleCheck class="h-3.5 w-3.5" />
          {{ t("sshTerminal.testSuccess") }}
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving || testing" @click="testConnection">
          <LoaderCircle v-if="testing" class="mr-1.5 h-4 w-4 animate-spin" />
          {{ t("sshTerminal.testConnection") }}
        </Button>
        <span class="flex-1" />
        <Button variant="outline" :disabled="saving || testing" @click="close">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!canSave || saving || testing" @click="save">
          <LoaderCircle v-if="saving" class="mr-1.5 h-4 w-4 animate-spin" />
          {{ t("common.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

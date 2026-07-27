<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Pencil, Plus, RefreshCw, Server, SquareTerminal, Trash2 } from "@lucide/vue";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import SshProfileDialog from "@/components/ssh/SshProfileDialog.vue";
import { deleteSshProfile, listSshProfiles } from "@/lib/backend/ssh-terminal-tauri";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { setSshTerminalProfile, sshTerminalRuntimeContext, type SshConnectionStatus } from "@/lib/ssh/terminalRegistry";
import type { SshProfile } from "@/types/ssh";

const emit = defineEmits<{
  open: [profileId: string, title: string];
}>();

const { t } = useI18n();
const profiles = ref<SshProfile[]>([]);
const loading = ref(false);
const loadError = ref("");
const dialogOpen = ref(false);
const editingProfile = ref<SshProfile | null>(null);
const deleteTarget = ref<SshProfile | null>(null);
const section = ref<HTMLElement | null>(null);
const HEIGHT_STORAGE_KEY = "dbx-ssh-sidebar-height";
const MIN_HEIGHT = 96;
const DEFAULT_HEIGHT = 220;
const sectionHeight = ref(Number.parseInt(safeLocalStorageGet(HEIGHT_STORAGE_KEY) || "", 10) || DEFAULT_HEIGHT);
let resizeStartY = 0;
let resizeStartHeight = 0;

const sectionStyle = computed(() => ({ height: `${sectionHeight.value}px`, maxHeight: "65%" }));

function profileStatus(profileId: string): SshConnectionStatus {
  return sshTerminalRuntimeContext(profileId)?.status ?? "disconnected";
}

function statusClass(status: SshConnectionStatus) {
  if (status === "connected") return "bg-emerald-500";
  if (status === "connecting") return "bg-amber-500";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground/45";
}

function statusLabel(status: SshConnectionStatus) {
  return t(`sshTerminal.${status}`);
}

async function loadProfiles() {
  if (!isTauriRuntime()) return;
  loading.value = true;
  loadError.value = "";
  try {
    profiles.value = await listSshProfiles();
    profiles.value.forEach(setSshTerminalProfile);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function createProfile() {
  editingProfile.value = null;
  dialogOpen.value = true;
}

function editProfile(profile: SshProfile) {
  editingProfile.value = profile;
  dialogOpen.value = true;
}

function openProfile(profile: SshProfile) {
  emit("open", profile.id, profile.name);
}

async function confirmDelete() {
  const profile = deleteTarget.value;
  if (!profile) return;
  try {
    await deleteSshProfile(profile.id);
    deleteTarget.value = null;
    await loadProfiles();
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}

function profileSaved(saved: SshProfile) {
  setSshTerminalProfile(saved);
  const index = profiles.value.findIndex((profile) => profile.id === saved.id);
  if (index >= 0) profiles.value[index] = saved;
  else profiles.value.push(saved);
  profiles.value.sort((left, right) => left.name.localeCompare(right.name));
}

function clampHeight(height: number) {
  const parentHeight = section.value?.parentElement?.clientHeight ?? window.innerHeight;
  return Math.round(Math.min(Math.max(MIN_HEIGHT, height), Math.max(MIN_HEIGHT, parentHeight * 0.65)));
}

function resizeMove(event: MouseEvent) {
  sectionHeight.value = clampHeight(resizeStartHeight + resizeStartY - event.clientY);
}

function resizeEnd() {
  document.removeEventListener("mousemove", resizeMove);
  document.removeEventListener("mouseup", resizeEnd);
  document.body.classList.remove("select-none", "cursor-row-resize");
  safeLocalStorageSet(HEIGHT_STORAGE_KEY, String(sectionHeight.value));
}

function resizeStart(event: MouseEvent) {
  resizeStartY = event.clientY;
  resizeStartHeight = section.value?.getBoundingClientRect().height ?? sectionHeight.value;
  document.addEventListener("mousemove", resizeMove);
  document.addEventListener("mouseup", resizeEnd);
  document.body.classList.add("select-none", "cursor-row-resize");
}

onMounted(loadProfiles);
onBeforeUnmount(resizeEnd);
</script>

<template>
  <section ref="section" class="relative flex min-h-24 shrink-0 flex-col border-t bg-background" :style="sectionStyle">
    <div class="absolute inset-x-0 top-0 z-10 h-2 -translate-y-1/2 cursor-row-resize" :title="t('sshTerminal.resizeProfiles')" @mousedown.prevent="resizeStart" />
    <div class="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/15 px-3 text-xs font-medium text-muted-foreground">
      <SquareTerminal class="h-3.5 w-3.5" />
      <span class="truncate">{{ t("sshTerminal.sectionTitle") }}</span>
      <span class="flex-1" />
      <LightTooltip :text="t('sshTerminal.refreshProfiles')" side="bottom" :delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="loading" @click="loadProfiles">
          <RefreshCw class="h-3 w-3" :class="loading ? 'animate-spin' : ''" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('sshTerminal.newProfile')" side="bottom" :delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="createProfile"><Plus class="h-3.5 w-3.5" /></Button>
      </LightTooltip>
    </div>

    <div class="min-h-0 overflow-y-auto py-1">
      <p v-if="loadError" class="break-words px-3 py-2 text-xs text-destructive">{{ loadError }}</p>
      <p v-else-if="!loading && profiles.length === 0" class="px-3 py-3 text-xs text-muted-foreground">{{ t("sshTerminal.noProfiles") }}</p>
      <div v-for="profile in profiles" :key="profile.id" class="group mx-1 flex h-10 cursor-default items-center gap-2 rounded px-2 hover:bg-muted/70" role="button" tabindex="0" @dblclick="openProfile(profile)" @keydown.enter.prevent="openProfile(profile)">
        <span class="relative flex h-4 w-4 shrink-0 items-center justify-center" :title="statusLabel(profileStatus(profile.id))">
          <Server class="h-3.5 w-3.5 text-muted-foreground" />
          <span class="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-background" :class="statusClass(profileStatus(profile.id))" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs font-medium text-foreground">{{ profile.name }}</div>
          <div class="truncate text-[10px] text-muted-foreground">{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</div>
        </div>
        <div class="hidden shrink-0 items-center gap-px group-hover:flex group-focus-within:flex">
          <LightTooltip :text="t('sshTerminal.openTerminal')" side="bottom" :delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-6 w-6" @click.stop="openProfile(profile)"><SquareTerminal class="h-3.5 w-3.5" /></Button>
          </LightTooltip>
          <LightTooltip :text="t('sshTerminal.editProfile')" side="bottom" :delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-6 w-6" @click.stop="editProfile(profile)"><Pencil class="h-3 w-3" /></Button>
          </LightTooltip>
          <LightTooltip :text="t('sshTerminal.deleteProfile')" side="bottom" :delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-6 w-6 text-destructive hover:text-destructive" @click.stop="deleteTarget = profile"><Trash2 class="h-3 w-3" /></Button>
          </LightTooltip>
        </div>
      </div>
    </div>

    <SshProfileDialog v-model:open="dialogOpen" :profile="editingProfile" @saved="profileSaved" />

    <Dialog :open="!!deleteTarget" @update:open="(open: boolean) => (open ? undefined : (deleteTarget = null))">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader
          ><DialogTitle>{{ t("sshTerminal.deleteProfile") }}</DialogTitle></DialogHeader
        >
        <p class="text-sm text-muted-foreground">{{ t("sshTerminal.deleteConfirm", { name: deleteTarget?.name }) }}</p>
        <DialogFooter>
          <Button variant="outline" @click="deleteTarget = null">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" @click="confirmDelete">{{ t("common.delete") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

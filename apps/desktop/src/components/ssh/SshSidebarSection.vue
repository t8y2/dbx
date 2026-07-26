<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Pencil, Plus, RefreshCw, Server, SquareTerminal, Trash2 } from "@lucide/vue";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import SshProfileDialog from "@/components/ssh/SshProfileDialog.vue";
import { deleteSshProfile, listSshProfiles } from "@/lib/backend/ssh-terminal-tauri";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
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

async function loadProfiles() {
  if (!isTauriRuntime()) return;
  loading.value = true;
  loadError.value = "";
  try {
    profiles.value = await listSshProfiles();
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
  const index = profiles.value.findIndex((profile) => profile.id === saved.id);
  if (index >= 0) profiles.value[index] = saved;
  else profiles.value.push(saved);
  profiles.value.sort((left, right) => left.name.localeCompare(right.name));
}

onMounted(loadProfiles);
</script>

<template>
  <section class="flex max-h-[42%] min-h-24 flex-col border-t bg-background">
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
        <Server class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
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

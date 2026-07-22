<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UpdateInfo } from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { canDownloadAndInstallUpdate } from "@/composables/useAppUpdater";

const open = defineModel<boolean>("open", { required: true });

const props = defineProps<{
  updateInfo: UpdateInfo | null;
  updateCheckMessage: string;
  isDownloadingUpdate: boolean;
  downloadProgress: number;
  updateDownloaded: boolean;
  isInstallingUpdate: boolean;
  updateReady: boolean;
  activeTaskCount: number;
}>();

const emit = defineEmits<{
  "open-latest-release": [];
  "download-and-install": [];
  "install-downloaded": [];
  restart: [];
}>();

const { t } = useI18n();
const isDesktop = isTauriRuntime();

const renderedNotes = ref("");
// Keep a downloaded package retryable after install errors; only active transitions must trap the dialog.
const isCloseBlocked = computed(() => props.isDownloadingUpdate || props.isInstallingUpdate || props.updateReady);

function handleReleaseNotesClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const anchor = target.closest("a");
  if (!anchor) return;
  event.preventDefault();
  const url = anchor.getAttribute("href");
  if (!url) return;
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

watch(
  () => props.updateInfo?.release_notes,
  async (notes) => {
    if (!notes) {
      renderedNotes.value = "";
      return;
    }
    const { Marked } = await import("marked");
    const marked = new Marked({ breaks: true, gfm: true });
    renderedNotes.value = marked.parse(notes) as string;
  },
  { immediate: true },
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="sm:max-w-[520px]"
      :show-close-button="!isCloseBlocked"
      @interact-outside="
        (e: Event) => {
          if (isCloseBlocked) e.preventDefault();
        }
      "
      @escape-key-down="
        (e: Event) => {
          if (isCloseBlocked) e.preventDefault();
        }
      "
    >
      <DialogHeader>
        <DialogTitle>{{ updateInfo?.update_available ? t("updates.availableTitle") : t("updates.title") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-3 text-sm">
        <p v-if="updateInfo?.update_available">
          {{
            t("updates.availableMessage", {
              current: updateInfo.current_version,
              latest: updateInfo.latest_version,
            })
          }}
        </p>
        <p v-else class="text-muted-foreground">
          {{ updateCheckMessage || t("updates.upToDate", { version: updateInfo?.current_version || "" }) }}
        </p>
        <div
          v-if="updateInfo?.update_available && updateInfo.release_notes"
          class="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 text-xs [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mb-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1 [&_li]:my-0.5 [&_p]:my-1 [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[11px] [&_a]:text-primary [&_a]:underline"
          v-html="renderedNotes"
          @click="handleReleaseNotesClick"
        />
        <p v-if="!isDesktop && updateInfo?.update_available" class="text-xs text-muted-foreground">
          {{ t("updates.dockerUsersRun") }}
          <code class="bg-muted px-1 py-0.5 rounded text-[11px]">docker compose pull && docker compose up -d</code>
          {{ t("updates.toUpdate") }}
        </p>
        <p v-if="isDesktop && updateInfo?.update_available && updateInfo.portable_mode" class="text-xs text-muted-foreground">
          {{ t("updates.portableAutomaticUpdate") }}
        </p>
        <div v-if="canDownloadAndInstallUpdate(updateInfo, isDesktop) && activeTaskCount > 0" role="alert" class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ t("updates.activeTasksBlockUpdate", { count: activeTaskCount }) }}</span>
        </div>
      </div>
      <DialogFooter>
        <Button v-if="!isCloseBlocked" variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <template v-if="updateInfo?.update_available">
          <Button variant="outline" @click="emit('open-latest-release')">{{ t("updates.openRelease") }}</Button>
          <template v-if="canDownloadAndInstallUpdate(updateInfo, isDesktop)">
            <Button v-if="updateReady" :disabled="activeTaskCount > 0" @click="emit('restart')">{{ t("updates.restart") }}</Button>
            <Button v-else-if="isInstallingUpdate" disabled>
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("updates.installing") }}
            </Button>
            <Button v-else-if="isDownloadingUpdate" disabled>
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("updates.downloading", { progress: downloadProgress }) }}
            </Button>
            <Button v-else-if="updateDownloaded" :disabled="activeTaskCount > 0" @click="emit('install-downloaded')">{{ t("updates.exitAndUpdate") }}</Button>
            <Button v-else :disabled="activeTaskCount > 0" @click="emit('download-and-install')">{{ t("updates.downloadAndInstall") }}</Button>
          </template>
        </template>
        <Button v-else-if="updateCheckMessage" @click="emit('open-latest-release')">{{ t("updates.openRelease") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

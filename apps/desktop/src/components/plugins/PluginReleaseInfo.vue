<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CalendarDays, FileText } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PluginMarketplaceVersion } from "@/types/database";
import { formatMarketplaceReleaseDate } from "@/lib/plugins/pluginMarketplace";
import { renderReleaseNotes } from "@/lib/markdown/releaseNotes";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const props = defineProps<{
  release?: PluginMarketplaceVersion;
}>();

const { locale, t } = useI18n();
const open = ref(false);
const dialogId = `plugin-release-notes-${useId()}`;

const releaseDate = computed(() => formatMarketplaceReleaseDate(props.release?.releasedAt, locale.value));
const releaseNotes = computed(() => props.release?.releaseNotes?.trim() || "");
const renderedReleaseNotes = computed(() => renderReleaseNotes(releaseNotes.value));
const releaseVersion = computed(() => props.release?.version?.trim() || "");
const hasReleaseInfo = computed(() => !!releaseDate.value || !!releaseNotes.value);

function handleReleaseNotesClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const anchor = target.closest("a");
  if (!anchor) return;
  event.preventDefault();
  const url = anchor.getAttribute("href");
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

watch(
  () => [props.release?.version, props.release?.releasedAt, props.release?.releaseNotes],
  () => {
    open.value = false;
  },
);
</script>

<template>
  <div v-if="hasReleaseInfo" data-plugin-release-info class="min-w-0 text-[11px] text-muted-foreground">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <div v-if="releaseDate" class="flex min-w-0 items-center gap-1.5">
        <CalendarDays class="size-3 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ t("pluginPlatform.updatedOn", { date: releaseDate }) }}</span>
      </div>
      <button
        v-if="releaseNotes"
        type="button"
        class="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-controls="dialogId"
        :aria-label="t('pluginPlatform.showReleaseNotes')"
        :title="t('pluginPlatform.showReleaseNotes')"
        @click="open = true"
      >
        <FileText class="size-3 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ t("pluginPlatform.showReleaseNotes") }}</span>
      </button>
    </div>

    <Dialog v-model:open="open">
      <DialogContent :id="dialogId" class="max-w-xl gap-3 p-5 sm:max-w-xl">
        <DialogHeader class="pr-7">
          <DialogTitle>{{ t("pluginPlatform.releaseNotesTitle") }}</DialogTitle>
          <DialogDescription v-if="releaseDate || releaseVersion" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span v-if="releaseDate" class="inline-flex items-center gap-1.5">
              <CalendarDays class="size-3 shrink-0" aria-hidden="true" />
              {{ t("pluginPlatform.updatedOn", { date: releaseDate }) }}
            </span>
            <span v-if="releaseVersion" class="text-muted-foreground/80">{{ t("pluginPlatform.versionLabel", { version: releaseVersion }) }}</span>
          </DialogDescription>
        </DialogHeader>
        <div
          data-plugin-release-notes
          class="max-h-[min(60vh,28rem)] overflow-y-auto break-words rounded-md border border-border/70 bg-muted/30 px-3 py-3 text-sm leading-6 text-foreground [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-primary [&_a]:underline"
          v-html="renderedReleaseNotes"
          @click="handleReleaseNotesClick"
        />
      </DialogContent>
    </Dialog>
  </div>
</template>

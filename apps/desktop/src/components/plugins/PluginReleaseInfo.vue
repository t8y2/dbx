<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CalendarDays, FileText } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PluginMarketplaceVersion } from "@/types/database";
import { formatMarketplaceReleaseDate } from "@/lib/plugins/pluginMarketplace";

const props = defineProps<{
  release?: PluginMarketplaceVersion;
}>();

const { locale, t } = useI18n();
const open = ref(false);
const dialogId = `plugin-release-notes-${useId()}`;

const releaseDate = computed(() => formatMarketplaceReleaseDate(props.release?.releasedAt, locale.value));
const releaseNotes = computed(() => props.release?.releaseNotes?.trim() || "");
const releaseVersion = computed(() => props.release?.version?.trim() || "");
const hasReleaseInfo = computed(() => !!releaseDate.value || !!releaseNotes.value);

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
        <div data-plugin-release-notes class="max-h-[min(60vh,28rem)] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/30 px-3 py-3 text-sm leading-6 text-foreground">
          {{ releaseNotes }}
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { UpdateInfo } from "@/lib/backend/api";
import type { AgentDriverInfo, McpServerStatus, UpdateDownloadSource } from "@/lib/backend/tauri";
import type { JdbcPluginStatus } from "@/types/database";
import type { MarketplacePluginListing } from "@/lib/plugins/pluginMarketplace";
import { mcpUpdateAvailability } from "@/lib/mcp/mcpUpdateStatus";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isUpdatePreviewMockEnabled } from "@/lib/updates/updatePreviewMock";
import { canDownloadAndInstallUpdate } from "@/composables/useAppUpdater";
import type { ComponentUpdateCategory } from "@/composables/useComponentUpdates";

type UpdateTab = "app" | ComponentUpdateCategory;

const open = defineModel<boolean>("open", { required: true });

const props = withDefaults(
  defineProps<{
    updateInfo: UpdateInfo | null;
    updateCheckMessage: string;
    isDownloadingUpdate: boolean;
    downloadProgress: number | null;
    updateDownloaded: boolean;
    isInstallingUpdate: boolean;
    isPreparingUpdate?: boolean;
    updateReady: boolean;
    isIgnoringUpdate: boolean;
    activeTaskCount: number;
    checkingUpdates: boolean;
    updateCheckFailed: boolean;
    updateDownloadSource: UpdateDownloadSource;
    driverUpdates?: AgentDriverInfo[];
    jdbcUpdate?: JdbcPluginStatus | null;
    mcpUpdate?: McpServerStatus | null;
    pluginUpdates?: MarketplacePluginListing[];
    componentUpdatesLoading?: boolean;
    componentUpdatesError?: string;
    componentUpdatesUpdating?: boolean;
    updatingComponent?: ComponentUpdateCategory | null;
    isUpdatingAll?: boolean;
  }>(),
  {
    driverUpdates: () => [],
    jdbcUpdate: null,
    mcpUpdate: null,
    pluginUpdates: () => [],
    componentUpdatesLoading: false,
    componentUpdatesError: "",
    componentUpdatesUpdating: false,
    updatingComponent: null,
    isUpdatingAll: false,
  },
);

const emit = defineEmits<{
  "open-latest-release": [];
  "download-in-background": [];
  "cancel-download": [];
  "install-downloaded": [];
  restart: [];
  "ignore-version": [];
  "change-download-source": [source: UpdateDownloadSource];
  "install-component-updates": [category: ComponentUpdateCategory];
  "update-all": [];
}>();

const { t } = useI18n();
const isDesktop = isTauriRuntime() || isUpdatePreviewMockEnabled();
const selectedTab = ref<UpdateTab>("app");
const renderedNotes = ref("");

const hasAppUpdate = computed(() => props.updateDownloaded || props.updateReady || props.updateInfo?.update_available === true);
const mcpAvailable = computed(() => (props.mcpUpdate ? mcpUpdateAvailability(props.mcpUpdate) === true : false));
const tabs = computed(() => {
  const available: Array<{ id: UpdateTab; label: string; count: number }> = [];
  if (hasAppUpdate.value) available.push({ id: "app", label: t("settings.updateClient"), count: 1 });
  if (props.driverUpdates.length) available.push({ id: "drivers", label: t("settings.updateDrivers"), count: props.driverUpdates.length });
  if (props.jdbcUpdate?.update_available) available.push({ id: "jdbc", label: t("settings.updateJdbc"), count: 1 });
  if (mcpAvailable.value) available.push({ id: "mcp", label: t("settings.updateMcp"), count: 1 });
  if (props.pluginUpdates.length) available.push({ id: "plugins", label: t("settings.updatePlugins"), count: props.pluginUpdates.length });
  return available.length ? available : [{ id: "app" as const, label: t("settings.updateClient"), count: 0 }];
});
const totalUpdateCount = computed(() => tabs.value.reduce((total, tab) => total + tab.count, 0));
const hasComponentUpdates = computed(() => props.driverUpdates.length > 0 || props.jdbcUpdate?.update_available === true || mcpAvailable.value || props.pluginUpdates.length > 0);
const selectedCategory = computed<ComponentUpdateCategory | null>(() => (selectedTab.value === "app" ? null : selectedTab.value));
const selectedCategoryHasUpdate = computed(() => {
  if (selectedTab.value === "drivers") return props.driverUpdates.length > 0;
  if (selectedTab.value === "jdbc") return props.jdbcUpdate?.update_available === true;
  if (selectedTab.value === "mcp") return mcpAvailable.value;
  if (selectedTab.value === "plugins") return props.pluginUpdates.length > 0;
  return false;
});
const isAnyComponentUpdating = computed(() => props.componentUpdatesUpdating || props.updatingComponent !== null);
// Component update tasks are owned by the app-level composable. Closing the
// dialog only leaves them running in the background; replacing an app update
// is the only operation that must keep the modal open.
const isCloseBlocked = computed(() => props.isInstallingUpdate);
const blocksImplicitDismiss = computed(() => isCloseBlocked.value);
const canIgnoreVersion = computed(() => props.updateInfo?.update_available === true && !props.isDownloadingUpdate && !props.isInstallingUpdate && !props.updateReady && !props.isUpdatingAll);

watch(
  tabs,
  (nextTabs) => {
    if (!nextTabs.some((tab) => tab.id === selectedTab.value)) selectedTab.value = nextTabs[0]?.id ?? "app";
  },
  { immediate: true },
);

function handleOpenChange(nextOpen: boolean) {
  if (nextOpen) {
    open.value = true;
    return;
  }
  if (isCloseBlocked.value) return;
  open.value = false;
}

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
  () => props.updateInfo?.release_notes,
  async (notes) => {
    if (!notes) {
      renderedNotes.value = "";
      return;
    }
    const { Marked } = await import("marked");
    const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const marked = new Marked({
      breaks: true,
      gfm: true,
      renderer: {
        html: ({ text }) => escapeHtml(text),
        link({ href, tokens }) {
          const text = this.parser.parseInline(tokens);
          return /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>` : text;
        },
        image: ({ text }) => escapeHtml(text),
      },
    });
    renderedNotes.value = marked.parse(notes) as string;
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent
      class="sm:max-w-[700px]"
      :class="'flex max-h-[min(720px,calc(var(--dbx-viewport-height)-48px))] flex-col gap-0 overflow-hidden p-0'"
      :show-close-button="!isCloseBlocked"
      @interact-outside="
        (e: Event) => {
          if (blocksImplicitDismiss) e.preventDefault();
        }
      "
      @escape-key-down="
        (e: Event) => {
          if (blocksImplicitDismiss) e.preventDefault();
        }
      "
    >
      <DialogHeader class="border-b py-4 pl-5 pr-12">
        <div class="flex items-center justify-between gap-4">
          <DialogTitle class="flex min-w-0 items-center gap-2">
            <span>{{ t("updates.centerTitle") }}</span>
            <span v-if="totalUpdateCount > 0" class="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{{ t("updates.centerAvailable", { count: totalUpdateCount }) }}</span>
          </DialogTitle>
          <Button v-if="hasComponentUpdates" type="button" size="sm" class="h-8 shrink-0" :disabled="props.isUpdatingAll || props.checkingUpdates || props.isDownloadingUpdate || props.isInstallingUpdate || isAnyComponentUpdating" @click="emit('update-all')">
            <Loader2 v-if="props.isUpdatingAll" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            {{ t("updates.updateAll") }}
          </Button>
        </div>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="border-b px-4 py-2">
          <div role="tablist" :aria-label="t('updates.centerTitle')" class="inline-flex h-9 w-full items-center justify-center rounded-md bg-muted p-[3px] text-muted-foreground">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              role="tab"
              :aria-selected="selectedTab === tab.id"
              :data-state="selectedTab === tab.id ? 'active' : 'inactive'"
              :data-update-tab="tab.id"
              class="relative inline-flex h-full flex-1 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 text-sm font-medium transition-colors hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
              :class="selectedTab === tab.id ? 'bg-background text-foreground shadow-sm' : 'text-foreground/60'"
              @click="selectedTab = tab.id"
            >
              <span>{{ tab.label }}</span>
              <span v-if="tab.count > 0" class="rounded-full bg-foreground/10 px-1.5 text-[11px]">{{ tab.count }}</span>
            </button>
          </div>
        </div>

        <div data-update-scroll-region class="min-h-0 flex-1 overflow-auto px-5 py-4 text-sm">
          <template v-if="selectedTab === 'app'">
            <div class="space-y-3">
              <p v-if="updateInfo?.update_available">
                {{
                  t("updates.availableMessage", {
                    current: updateInfo.current_version,
                    latest: updateInfo.latest_version,
                  })
                }}
              </p>
              <p v-else-if="!checkingUpdates" class="text-muted-foreground">
                {{ updateCheckMessage || t("updates.upToDate", { version: updateInfo?.current_version || "" }) }}
              </p>
              <div
                v-if="updateInfo?.update_available && updateInfo.release_notes"
                class="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs [&_h1]:mb-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:my-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px] [&_a]:text-primary [&_a]:underline"
                v-html="renderedNotes"
                @click="handleReleaseNotesClick"
              />
              <p v-if="!isDesktop && updateInfo?.update_available" class="text-xs text-muted-foreground">
                {{ t("updates.dockerUsersRun") }}
                <code class="rounded bg-muted px-1 py-0.5 text-[11px]">docker compose pull && docker compose up -d</code>
                {{ t("updates.toUpdate") }}
              </p>
              <p v-if="isDesktop && updateInfo?.update_available && updateInfo.portable_mode && !updateInfo.manual_update_only" class="text-xs text-muted-foreground">
                {{ t("updates.portableAutomaticUpdate") }}
              </p>
              <p v-if="isDesktop && updateInfo?.update_available && updateInfo.manual_update_only" class="text-xs text-muted-foreground">
                {{ t("updates.windows7ManualUpdate") }}
              </p>
              <div v-if="canDownloadAndInstallUpdate(updateInfo, isDesktop) && activeTaskCount > 0" role="alert" class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
                <span>{{ t("updates.activeTasksBlockUpdate", { count: activeTaskCount }) }}</span>
              </div>
            </div>
            <p v-if="checkingUpdates" class="mt-3 flex items-center gap-2 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("updates.checking") }}
            </p>
            <p v-if="updateDownloaded && !isInstallingUpdate" class="mt-3">{{ t("updates.downloadedReady", { version: updateInfo?.latest_version }) }}</p>
            <p v-if="updateCheckFailed && updateInfo?.update_available" role="alert" class="mt-3 text-destructive">{{ updateCheckMessage }}</p>
          </template>

          <template v-else>
            <div v-if="componentUpdatesLoading && !selectedCategoryHasUpdate" class="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("updates.checking") }}
            </div>
            <div v-else class="space-y-2">
              <div v-if="componentUpdatesError" class="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
                <span>{{ componentUpdatesError }}</span>
              </div>
              <template v-if="selectedTab === 'drivers'">
                <div v-for="driver in driverUpdates" :key="driver.db_type" class="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div class="min-w-0">
                    <div class="font-medium">{{ driver.label }}</div>
                    <div class="mt-0.5 text-xs text-muted-foreground">{{ driver.installed_version || driver.version }} → {{ driver.version }}</div>
                  </div>
                  <span class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{{ t("settings.updateAvailable") }}</span>
                </div>
              </template>

              <template v-else-if="selectedTab === 'jdbc' && jdbcUpdate?.update_available">
                <div class="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div class="min-w-0">
                    <div class="font-medium">{{ t("settings.updateJdbc") }}</div>
                    <div class="mt-0.5 text-xs text-muted-foreground">{{ jdbcUpdate.version || t("updates.notInstalled") }} → {{ jdbcUpdate.latest_version || t("settings.updateAvailable") }}</div>
                  </div>
                  <span class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{{ t("settings.updateAvailable") }}</span>
                </div>
              </template>

              <template v-else-if="selectedTab === 'mcp' && mcpAvailable && mcpUpdate">
                <div class="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div class="min-w-0">
                    <div class="font-medium">{{ t("settings.updateMcp") }}</div>
                    <div class="mt-0.5 text-xs text-muted-foreground">{{ mcpUpdate.current_version || t("updates.notInstalled") }} → {{ mcpUpdate.latest_version || t("settings.updateAvailable") }}</div>
                  </div>
                  <span class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{{ t("settings.updateAvailable") }}</span>
                </div>
              </template>

              <template v-else-if="selectedTab === 'plugins'">
                <div v-for="plugin in pluginUpdates" :key="plugin.key" class="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div class="min-w-0">
                    <div class="truncate font-medium">{{ plugin.name }}</div>
                    <div class="mt-0.5 text-xs text-muted-foreground">{{ plugin.installed?.manifest.version || t("updates.notInstalled") }} → {{ plugin.plugin.latestVersion }}</div>
                  </div>
                  <span class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{{ t("settings.updateAvailable") }}</span>
                </div>
              </template>

              <div v-if="!selectedCategoryHasUpdate" class="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                <CheckCircle2 class="h-6 w-6 text-emerald-500" />
                {{ t("settings.upToDate") }}
              </div>
            </div>
          </template>
        </div>

        <DialogFooter v-if="selectedTab === 'app'" data-update-footer class="mx-0 mb-0 min-w-0 rounded-none border-t px-[22px] pb-2.5 pt-2.5 sm:items-center sm:justify-end">
          <div v-if="!updateReady && !isInstallingUpdate && !updateDownloaded && (updateInfo?.update_available || updateCheckFailed)" class="flex items-center gap-1.5 self-start sm:mr-auto sm:self-center">
            <span class="text-xs text-muted-foreground">{{ t("updates.source") }}</span>
            <Select :model-value="updateDownloadSource" :disabled="checkingUpdates || isIgnoringUpdate" @update:model-value="(value) => value && emit('change-download-source', value as UpdateDownloadSource)">
              <SelectTrigger class="h-8 w-[150px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="official">{{ t("updates.sourceOfficial") }}</SelectItem>
                <SelectItem value="cnb">{{ t("updates.sourceCnb") }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <template v-if="updateInfo?.update_available">
            <div class="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
              <Button v-if="canIgnoreVersion" variant="ghost" class="shrink-0" :disabled="isIgnoringUpdate" @click="emit('ignore-version')">
                <Loader2 v-if="isIgnoringUpdate" class="h-4 w-4 animate-spin" />
                {{ t("updates.ignoreVersion") }}
              </Button>
              <Button variant="outline" class="shrink-0" @click="emit('open-latest-release')">{{ t("updates.openRelease") }}</Button>
            </div>
            <template v-if="canDownloadAndInstallUpdate(updateInfo, isDesktop)">
              <Button v-if="updateReady" class="shrink-0" :disabled="activeTaskCount > 0 || isIgnoringUpdate || isUpdatingAll" @click="emit('restart')">{{ t("updates.restart") }}</Button>
              <Button v-else-if="isInstallingUpdate" class="shrink-0" disabled>
                <Loader2 class="h-4 w-4 animate-spin" />
                {{ t(isPreparingUpdate ? "updates.preparing" : "updates.installing") }}
              </Button>
              <template v-else-if="isDownloadingUpdate">
                <Button variant="ghost" class="shrink-0" @click="emit('cancel-download')">{{ t("updates.cancelDownload") }}</Button>
                <Button class="w-52 shrink-0 tabular-nums" disabled>
                  <Loader2 class="h-4 w-4 animate-spin" />
                  {{ t("updates.downloading", { progress: downloadProgress ?? 0 }) }}
                </Button>
              </template>
              <Button v-else-if="updateDownloaded" class="shrink-0" :disabled="activeTaskCount > 0 || isIgnoringUpdate || isUpdatingAll" @click="emit('install-downloaded')">{{ t("updates.restartAndUpdate") }}</Button>
              <Button v-else-if="!checkingUpdates" class="shrink-0" :disabled="isIgnoringUpdate" @click="emit('download-in-background')">{{ t(updateCheckFailed ? "updates.retryDownload" : "updates.downloadInBackground") }}</Button>
            </template>
          </template>
          <template v-else>
            <div class="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
              <Button v-if="updateCheckMessage" class="shrink-0" @click="emit('open-latest-release')">{{ t("updates.openRelease") }}</Button>
            </div>
          </template>
        </DialogFooter>

        <DialogFooter v-else data-update-footer class="mx-0 mb-0 rounded-none border-t px-[22px] pb-2.5 pt-2.5 sm:items-center sm:justify-end">
          <template v-if="isAnyComponentUpdating">
            <Button variant="ghost" class="shrink-0" @click="handleOpenChange(false)">{{ t("updates.updateInBackground") }}</Button>
            <Button class="shrink-0" disabled>
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("updates.updating") }}
            </Button>
          </template>
          <Button v-else-if="selectedCategory" :disabled="!selectedCategoryHasUpdate || isInstallingUpdate || isUpdatingAll" @click="emit('install-component-updates', selectedCategory)">
            {{ t("updates.updateNow") }}
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>

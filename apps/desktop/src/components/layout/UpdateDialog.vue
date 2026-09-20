<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Loader2, Download, RefreshCw, ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { UpdateInfo } from "@/lib/backend/api";
import type { UpdateDownloadSource } from "@/lib/backend/tauri";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { canDownloadAndInstallUpdate } from "@/composables/useAppUpdater";
import type { UnifiedUpdateItem } from "@/composables/useUnifiedUpdates";
import DriverInstallProgressCircle from "@/components/config/DriverInstallProgressCircle.vue";

const open = defineModel<boolean>("open", { required: true });

const props = defineProps<{
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
  /** 聚合的额外更新项（driver / jdbc / plugin / mcp） */
  extraItems?: UnifiedUpdateItem[];
  /** 是否正在加载 extraItems */
  extraItemsLoading?: boolean;
  /** extraItems 加载错误 */
  extraItemsError?: string;
  /** "全部更新（可自动项）"是否正在执行 */
  extraItemsAllUpdating?: boolean;
}>();

const emit = defineEmits<{
  "open-latest-release": [];
  "download-in-background": [];
  "cancel-download": [];
  "install-downloaded": [];
  restart: [];
  "ignore-version": [];
  "change-download-source": [source: UpdateDownloadSource];
  /** 用户点击 extra items 里某一行的"更新"按钮 */
  "update-item": [id: string];
  /** 用户点击 extra items 里的"全部更新"按钮 */
  "update-all-auto": [];
  /** 用户点击刷新 extra items */
  "refresh-extra-items": [];
}>();

const { t } = useI18n();
const isDesktop = isTauriRuntime();

const renderedNotes = ref("");
// Only active file replacement (installation) must trap the dialog. A background
// download survives the dialog closing, so closing it never cancels the download.
const isCloseBlocked = computed(() => props.isInstallingUpdate);
const blocksImplicitDismiss = computed(() => props.isInstallingUpdate);
const canIgnoreVersion = computed(() => props.updateInfo?.update_available === true && !props.isDownloadingUpdate && !props.isInstallingUpdate && !props.updateReady);
/** 列表中是否存在可批量自动更新的项（决定"全部更新"按钮是否出现） */
const hasAutoUpdatable = computed(() => (props.extraItems ?? []).some((item) => item.canAutoUpdate));
/**
 * "全部更新"按钮组是否显示。
 * DBX 本体进入下载中 / 已下载完成时，列表里的其余更新项都已处理完，
 * 按钮组不再需要显示 —— 否则底部会挤成"打开发行版 / 全部更新 / 取消下载 / 下载中"。
 */
const showUpdateAll = computed(() => hasAutoUpdatable.value && !props.isDownloadingUpdate && !props.updateDownloaded);
/**
 * 下拉里的"后台下载"触发器是否显示。
 * 只有 DBX 本体具备自动下载条件（非 Win7 手动更新等受限环境）时该入口才有意义，
 * 其余情况按钮组退化为单个"全部更新"按钮。
 */
const canDownloadInBackground = computed(() => canDownloadAndInstallUpdate(props.updateInfo, isDesktop) && !props.isDownloadingUpdate && !props.updateDownloaded && !props.isInstallingUpdate && !props.updateReady);

/**
 * 下拉菜单里的"后台下载"：先关闭弹窗，再在后台静默跑完整流程（驱动 → 插件 → DBX 本体）。
 * 更新逻辑挂在 App.vue 层，关闭弹窗不会中断；重新打开"检查更新"即可看到剩余项与进度。
 */
function handleMoreUpdateAction() {
  handleOpenChange(false);
  emit("update-all-auto");
}

function handleCancel() {
  handleOpenChange(false);
}

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
      class="sm:max-w-[700px] flex flex-col max-h-[85vh]"
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
      <DialogHeader class="shrink-0">
        <DialogTitle>{{ updateInfo?.update_available ? t("updates.availableTitle") : t("updates.title") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-3 text-sm shrink-0">
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
          class="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 text-xs [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mb-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1 [&_li]:my-0.5 [&_p]:my-1 [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[11px] [&_a]:text-primary [&_a]:underline"
          v-html="renderedNotes"
          @click="handleReleaseNotesClick"
        />
        <p v-if="!isDesktop && updateInfo?.update_available" class="text-xs text-muted-foreground">
          {{ t("updates.dockerUsersRun") }}
          <code class="bg-muted px-1 py-0.5 rounded text-[11px]">docker compose pull && docker compose up -d</code>
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
      <p v-if="checkingUpdates" class="text-sm text-muted-foreground">{{ t("updates.checking") }}</p>
      <p v-if="updateDownloaded && !isInstallingUpdate" class="text-sm">{{ t("updates.downloadedReady", { version: updateInfo?.latest_version }) }}</p>
      <p v-if="updateCheckFailed && updateInfo?.update_available" role="alert" class="text-sm text-destructive">{{ updateCheckMessage }}</p>

      <!-- ───────────── 额外可更新项目（mcp / driver / jdbc / plugin，已过滤为仅 hasUpdate ───────────── -->
      <div v-if="extraItemsError || extraItemsLoading || (extraItems && extraItems.length > 0)" class="mt-4 flex-1 min-h-0 flex flex-col space-y-2">
        <div class="flex shrink-0 items-center justify-between">
          <h3 class="text-sm font-medium">{{ t("updates.otherUpdatesTitle") }}</h3>
          <Button v-if="!extraItemsLoading" variant="ghost" size="icon" class="h-6 w-6" :title="t('common.refresh')" @click="emit('refresh-extra-items')">
            <RefreshCw class="h-3 w-3" />
          </Button>
          <Loader2 v-else class="h-3 w-3 animate-spin text-muted-foreground" />
        </div>

        <p v-if="extraItemsError" role="alert" class="text-xs text-destructive shrink-0">{{ extraItemsError }}</p>

        <!-- 项目列表：内部滚动，DialogFooter 保持固定。
             已有数据时优先渲染列表（刷新过程静默进行），避免更新完成后列表闪成"加载中" -->
        <div v-if="extraItems && extraItems.length > 0" class="rounded-md border divide-y flex-1 min-h-0 overflow-y-auto">
          <div v-for="item in extraItems" :key="item.id" class="flex items-center gap-3 px-3 py-2 text-xs">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="font-medium truncate">{{ item.name }}</span>
                <span class="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">{{ t("updates.availableBadge") }}</span>
              </div>
              <div class="mt-0.5 text-muted-foreground">
                <span v-if="item.currentVersion">v{{ item.currentVersion }}</span>
                <span v-if="item.latestVersion">
                  → <span class="text-amber-600 font-medium">v{{ item.latestVersion }}</span></span
                >
                <span v-else class="text-amber-600 font-medium">{{ t("updates.newVersionAvailable") }}</span>
              </div>
            </div>
            <div class="shrink-0 flex items-center gap-2">
              <!-- DBX App 下载中：复用与驱动管理一致的环形进度（百分比来自主区域下载状态机） -->
              <DriverInstallProgressCircle v-if="item.kind === 'app' && isDownloadingUpdate" :percent="downloadProgress ?? 0" :title="`${item.name} ${t('common.loading')}`" />
              <!-- 有真实下载进度（agent driver / jdbc plugin）：环形百分比进度条，与驱动管理保持一致 -->
              <DriverInstallProgressCircle v-else-if="item.updating && item.percent != null" :percent="item.percent" :title="`${item.name} ${t('common.loading')}`" />
              <!-- 正在更新但无进度通道（mcp / plugin / agent 无百分比步骤）：持续旋转的小环形 spinner -->
              <span v-else-if="item.updating" class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full" role="status" :title="`${item.name} ${t('common.loading')}`">
                <svg class="absolute inset-0 h-8 w-8 -rotate-90 animate-spin" viewBox="0 0 32 32" aria-hidden="true">
                  <circle class="text-green-600/20" cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="3" />
                  <circle class="text-green-600" cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="40 100" />
                </svg>
              </span>
              <!-- DBX App：触发主区域的后台下载；下载完成后直接进入安装 -->
              <!-- 与页脚保持一致：下载不禁用，安装（退出并更新）在有活跃任务时必须禁用 -->
              <Button
                v-else-if="item.kind === 'app'"
                type="button"
                size="sm"
                variant="outline"
                class="h-7 rounded-md text-xs"
                :disabled="isDownloadingUpdate || isInstallingUpdate || (updateDownloaded && activeTaskCount > 0)"
                @click="updateDownloaded ? emit('install-downloaded') : emit('download-in-background')"
              >
                <Download class="h-3 w-3 mr-1" />
                {{ updateDownloaded ? t("updates.restartAndUpdate") : t("updates.updateNow") }}
              </Button>
              <!-- 其余可自动更新项（mcp / jdbc plugin / marketplace 插件 / agent 驱动）就地更新 -->
              <Button v-else-if="item.canAutoUpdate" type="button" size="sm" variant="outline" class="h-7 rounded-md text-xs" @click="emit('update-item', item.id)">
                <Download class="h-3 w-3 mr-1" />
                {{ t("updates.updateNow") }}
              </Button>
            </div>
          </div>
        </div>

        <!-- 首次加载（还没有任何列表数据）时显示加载提示 -->
        <div v-else-if="extraItemsLoading" class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3 w-3 animate-spin" />
          {{ t("updates.loadingExtraUpdates") }}
        </div>
      </div>

      <DialogFooter class="relative min-w-0 sm:justify-end shrink-0">
        <div class="flex flex-col items-start gap-2 self-start sm:absolute sm:left-4 sm:top-1/2 sm:-translate-y-1/2">
          <div v-if="!updateReady && !isInstallingUpdate && !updateDownloaded && (updateInfo?.update_available || updateCheckFailed)" class="flex items-center gap-1.5">
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
        </div>
        <!-- 左侧操作组：取消 / 忽略此版本 / 打开发行版 / 全部更新（按钮组） -->
        <div class="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
          <Button v-if="!isCloseBlocked" variant="outline" class="shrink-0" @click="handleCancel">{{ t("dangerDialog.cancel") }}</Button>
          <Button v-if="canIgnoreVersion" variant="ghost" class="shrink-0" :disabled="isIgnoringUpdate" @click="emit('ignore-version')">
            <Loader2 v-if="isIgnoringUpdate" class="h-4 w-4 animate-spin" />
            {{ t("updates.ignoreVersion") }}
          </Button>
          <Button v-if="updateInfo?.update_available || updateCheckMessage" variant="outline" class="shrink-0" @click="emit('open-latest-release')">{{ t("updates.openRelease") }}</Button>
          <!-- 按钮组：主按钮与下拉项都执行"全部更新"（驱动 → 插件 → DBX 本体，逐个串行） -->
          <div v-if="showUpdateAll" class="flex shrink-0 items-stretch">
            <Button data-testid="update-all-button" :class="canDownloadInBackground ? 'rounded-r-none' : ''" :disabled="extraItemsAllUpdating" @click="emit('update-all-auto')">
              <Loader2 v-if="extraItemsAllUpdating" class="h-4 w-4 animate-spin" />
              {{ t("updates.updateAllAuto") }}
            </Button>
            <DropdownMenu v-if="canDownloadInBackground">
              <DropdownMenuTrigger as-child>
                <Button data-testid="download-in-background-trigger" class="rounded-l-none border-l border-primary-foreground/25 px-1.5" :disabled="extraItemsAllUpdating" :aria-label="t('updates.updateAllMore')">
                  <ChevronDown class="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-auto min-w-44">
                <DropdownMenuItem @select="handleMoreUpdateAction">
                  <Download />
                  {{ t("updates.downloadInBackground") }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <!-- 右侧：DBX 本体的下载 / 安装过程态（"后台下载"入口已并入上面的按钮组下拉） -->
        <template v-if="updateInfo?.update_available && canDownloadAndInstallUpdate(updateInfo, isDesktop)">
          <Button v-if="updateReady" class="shrink-0" :disabled="activeTaskCount > 0 || isIgnoringUpdate" @click="emit('restart')">{{ t("updates.restart") }}</Button>
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
          <Button v-else-if="updateDownloaded" class="shrink-0" :disabled="activeTaskCount > 0 || isIgnoringUpdate" @click="emit('install-downloaded')">{{ t("updates.restartAndUpdate") }}</Button>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { buildMarketplacePluginListings, beaconPluginInstall, type MarketplacePluginListing } from "@/lib/plugins/pluginMarketplace";
import { clearPluginIconCache } from "@/lib/plugins/pluginIconResolver";
import type { McpServerStatus, AgentDriverInfo } from "@/lib/backend/tauri";
import type { UpdateInfo } from "@/lib/backend/api";
import type { InstalledPlugin, PluginRepositoryCatalogResult, JdbcPluginStatus } from "@/types/database";
import { driverInstallProgressChannel, driverInstallProgressPercent, type DriverInstallProgress } from "@/lib/connection/driverInstallProgressUi";
import { uuid } from "@/lib/common/utils";

/**
 * UnifiedUpdateItem —— 统一更新项数据结构
 *
 * 把 DBX App / MCP / Agent 驱动 / JDBC 插件 / Marketplace 插件这 5 类更新源
 * 映射成同构的行数据，供 UpdateDialog 统一渲染。
 *
 * 各类型差异：
 *  - app        : 更新走主区域的"后台下载 → 退出并更新 → 重启"状态机（由 useAppUpdater 驱动），
 *                 在"全部更新"里排在最后，且只触发后台下载，安装/重启仍由用户确认
 *  - mcp        : 通过 api.installMcpServer() 直接升级
 *  - agentDriver: 数量不固定（已安装且有待更新的每个驱动一行），
 *                 通过 api.installAgent(dbType, operationId) 逐个升级
 *  - jdbcPlugin : 单行，通过 api.installJdbcPlugin 直接更新
 *  - plugin     : Marketplace 中 status==='update' 的已安装插件，
 *                 通过 api.installMarketplacePlugin 直接更新
 *
 * @author yanlexing
 */
export type UnifiedUpdateKind = "app" | "mcp" | "agentDriver" | "jdbcPlugin" | "plugin";

/**
 * "全部更新"的执行顺序：驱动 → 插件（MCP / JDBC / marketplace）→ DBX 本体。
 * 逐个串行执行，一次只跑一个下载，避免并发抢占带宽和磁盘导致界面卡顿。
 */
const AUTO_UPDATE_ORDER: Record<UnifiedUpdateKind, number> = {
  agentDriver: 0,
  mcp: 1,
  jdbcPlugin: 1,
  plugin: 1,
  app: 2,
};

export interface UnifiedUpdateItem {
  /** 唯一标识，如 'app' / 'mcp' / 'agent:dameng' / 'jdbc-plugin' / 'plugin:redis' */
  id: string;
  /** 更新类型——决定 UI 展示和"更新"按钮行为 */
  kind: UnifiedUpdateKind;
  /** 显示名称 */
  name: string;
  /** 当前版本（app 更新场景下可能为空） */
  currentVersion?: string;
  /** 最新版本 */
  latestVersion?: string;
  /** 是否有新版本可用 */
  hasUpdate: boolean;
  /** 能否由"全部更新"批量执行（app 需要重启应用，不参与批量） */
  canAutoUpdate: boolean;
  /** 是否正在更新（UI 中显示 loading） */
  updating: boolean;
  /** 真实下载进度 0~100（仅 agent driver / jdbc plugin 有进度事件；mcp / plugin / app 为 null） */
  percent?: number | null;
  /** 对于 marketplace plugin，保存完整 listing 便于后续 installMarketplacePlugin 调用 */
  pluginListing?: MarketplacePluginListing;
  /** 对于 agent driver，保存 db_type 便于 installAgent / 路由到 DriverStoreDialog 定位 */
  agentDbType?: string;
}

/**
 * 聚合 5 类更新源，供 UpdateDialog 统一渲染。
 *
 * 使用方式：
 *   const { items, refreshAll, updateItem, updateAllAuto } = useUnifiedUpdates({
 *     appUpdateInfo,        // ref<UpdateInfo | null> —— 来自 useAppUpdater
 *   });
 *   // 打开 UpdateDialog 时调用 refreshAll() 拉取 driver / jdbc / mcp / plugin 数据
 */
export function useUnifiedUpdates(options: {
  appUpdateInfo: { value: UpdateInfo | null };
  /**
   * 触发 DBX 本体更新包的后台下载。
   * "全部更新"把 DBX 本体排在最后，且只触发下载 —— 安装/重启仍需用户在页脚点确认，
   * 避免批量更新自动重启应用。不传时 DBX 本体不参与批量。
   */
  onAppDownload?: () => void;
}) {
  const { t, locale: appLocale } = useI18n();

  const items = ref<UnifiedUpdateItem[]>([]);
  const loading = ref(false);
  const error = ref("");
  const allUpdating = ref(false);
  const installedPlugins = ref<InstalledPlugin[]>([]);
  const catalogResults = ref<PluginRepositoryCatalogResult[]>([]);

  /** 已安装的进度监听取消函数 */
  let unlistenProgress: (() => void) | null = null;

  /**
   * 本 composable 发起的 agent / jdbc 安装操作 ID 集合。
   * 进度事件是全局广播的（DriverStoreDialog 也在监听同一通道），
   * 只处理自己发起的操作，避免把别的对话框的进度串到本列表上。
   * 注意：后端的旧版本事件可能不带 operation_id，这类事件仍然接受。
   */
  const ownOperationIds = new Set<string>();

  /**
   * 订阅后端的 driver / jdbc 安装进度事件。
   * 通道覆盖两类：agent driver（通过 db_type 识别）和 jdbc plugin（通过 step === "jdbc-plugin" 识别）。
   * 收到事件后直接 mutate items 中对应 item 的 percent + updating 字段，UI 自动响应。
   */
  function subscribeProgress() {
    if (unlistenProgress) return;
    api
      .listenAgentInstallProgress((payload: DriverInstallProgress) => {
        const channel = driverInstallProgressChannel(payload);
        if (!channel) return;
        // 只处理本组件发起的操作（旧版后端可能不带 operation_id，此时放行）
        if (payload.operation_id && !ownOperationIds.has(payload.operation_id)) return;

        // 定位到对应的行：jdbc 插件只有一行，agent 驱动按 db_type 匹配
        const target = channel === "jdbc-plugin" ? items.value.find((i) => i.id === "jdbc-plugin") : payload.db_type ? items.value.find((i) => i.id === `agent:${payload.db_type}`) : undefined;
        if (!target) return;

        // 安装过程中会依次收到 driver / jre-extract 等步骤，其中部分步骤没有 downloaded/total，
        // 此时 percent 为 null —— UI 退化为旋转环，但仍保持 updating=true，
        // 直到 step === "done" 才结束该行的更新态。
        const done = payload.step === "done";
        target.updating = !done;
        target.percent = done ? null : driverInstallProgressPercent(payload);
        if (done && payload.operation_id) ownOperationIds.delete(payload.operation_id);
      })
      .then((unlisten) => {
        unlistenProgress = unlisten;
      })
      .catch(() => {
        // 后端尚未就绪时 listen 可能抛错，忽略即可
      });
  }

  /** 组件卸载时取消订阅 */
  onBeforeUnmount(() => {
    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = null;
    }
  });

  /** 保留重建前各 item 的 updating / percent 状态，避免刷新时进度条闪烁 */
  function preserveProgressState(rebuilt: UnifiedUpdateItem[]) {
    for (const newItem of rebuilt) {
      const prev = items.value.find((i) => i.id === newItem.id);
      if (prev) {
        newItem.updating = prev.updating;
        newItem.percent = prev.percent;
      }
    }
  }

  /** 聚合 app / mcp / agent / jdbc / plugin 到 items 数组 */
  function rebuildItems(appInfo: UpdateInfo | null, mcp: McpServerStatus | null, drivers: AgentDriverInfo[], jdbc: JdbcPluginStatus | null, plugins: MarketplacePluginListing[]) {
    const rebuilt: UnifiedUpdateItem[] = [];

    // 0) DBX App —— 固定放列表首行；"更新"按钮触发主区域的后台下载
    if (appInfo?.update_available) {
      rebuilt.push({
        id: "app",
        kind: "app",
        name: "DBX",
        currentVersion: appInfo.current_version,
        latestVersion: appInfo.latest_version,
        hasUpdate: true,
        canAutoUpdate: true, // 参与"全部更新"，但排在最后且只触发后台下载
        updating: false,
      });
    }

    // 1) MCP Server —— 只显示已安装且有更新的
    if (mcp && mcp.installed && mcp.update_available) {
      rebuilt.push({
        id: "mcp",
        kind: "mcp",
        name: "DBX MCP Server",
        currentVersion: mcp.current_version ?? undefined,
        latestVersion: mcp.latest_version ?? undefined,
        hasUpdate: true,
        canAutoUpdate: true, // api.installMcpServer() 可直接升级
        updating: false,
      });
    }

    // 2) Agent 驱动 —— 只显示已安装且有更新的
    for (const driver of drivers) {
      if (!driver.installed || !driver.update_available) continue;
      rebuilt.push({
        id: `agent:${driver.db_type}`,
        kind: "agentDriver",
        name: driver.label || driver.db_type,
        currentVersion: driver.installed_version ?? undefined,
        latestVersion: driver.version || undefined,
        hasUpdate: true,
        canAutoUpdate: true, // api.installAgent(dbType, operationId) 可单个升级
        updating: false,
        agentDbType: driver.db_type,
      });
    }

    // 3) JDBC 插件 —— 只显示已安装且有更新的
    if (jdbc?.installed && jdbc.update_available) {
      rebuilt.push({
        id: "jdbc-plugin",
        kind: "jdbcPlugin",
        name: t("settings.jdbcPlugin") || "JDBC 插件",
        currentVersion: jdbc.version ?? undefined,
        latestVersion: jdbc.latest_version ?? undefined,
        hasUpdate: true,
        canAutoUpdate: true,
        updating: false, // 更新中的状态由 updateItem 直接在 item 上 mutate
      });
    }

    // 4) Marketplace 插件 —— 只保留 status==='update' 的
    for (const listing of plugins) {
      if (listing.status !== "update") continue;
      rebuilt.push({
        id: `plugin:${listing.plugin.id}`,
        kind: "plugin",
        name: listing.name,
        currentVersion: listing.installed?.manifest.version ?? undefined,
        latestVersion: listing.plugin.latestVersion,
        hasUpdate: true,
        canAutoUpdate: true,
        updating: false,
        pluginListing: listing,
      });
    }

    preserveProgressState(rebuilt);
    items.value = rebuilt;
  }

  /** 拉取 mcp / agent / jdbc / plugin 四类数据 */
  async function refreshAll() {
    // 首次刷新时订阅进度通道（幂等）
    subscribeProgress();
    loading.value = true;
    error.value = "";
    try {
      const [mcp, drivers, jdbc, plugins, catalogs] = await Promise.all([api.checkMcpServerStatus(), api.listInstalledAgents(), api.jdbcPluginStatus(), api.listPlugins(), api.fetchPluginMarketplaceCatalogs()]);
      installedPlugins.value = plugins;
      catalogResults.value = catalogs;
      const listings = buildMarketplacePluginListings(catalogs, plugins, appLocale.value);
      rebuildItems(options.appUpdateInfo.value, mcp, drivers, jdbc, listings);
    } catch (e: any) {
      error.value = e?.message ?? String(e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 更新单个可自动更新的项目（app / mcp / jdbc / plugin / agentDriver）。
   *
   * @param id 目标行的 item.id
   * @returns true 表示该项目的更新请求已成功完成
   */
  async function updateItem(id: string): Promise<boolean> {
    const item = items.value.find((i) => i.id === id);
    if (!item || !item.hasUpdate || item.updating || !item.canAutoUpdate) return false;

    // DBX 本体：只触发后台下载，安装/重启由用户在页脚确认。
    // 下载进度由主区域的下载状态机驱动（行内环形进度直接读 downloadProgress），
    // 因此不占用 item.updating，也不从列表移除该行。
    if (item.kind === "app") {
      if (!options.onAppDownload) return false;
      options.onAppDownload();
      return true;
    }

    // 统一用 item.updating 管理 loading 状态
    item.updating = true;
    try {
      if (item.kind === "mcp") {
        await api.installMcpServer();
      } else if (item.kind === "jdbcPlugin") {
        await api.installJdbcPlugin();
      } else if (item.kind === "plugin" && item.pluginListing) {
        const listing = item.pluginListing;
        await api.installMarketplacePlugin({
          repositoryId: listing.repository.id,
          pluginId: listing.plugin.id,
          version: listing.plugin.latestVersion,
        });
        beaconPluginInstall(listing.plugin.id, listing.plugin.latestVersion);
        clearPluginIconCache();
      } else if (item.kind === "agentDriver" && item.agentDbType) {
        const dbType = item.agentDbType;
        // 与"驱动管理"保持一致：先检查阻塞项（如正在运行的驱动运行时），有阻塞则提示并中止
        const blockers = await api.checkAgentUpdateBlockers([dbType]);
        if (blockers.length > 0) {
          error.value = t("driverStore.driverUpdateBlocked", { labels: blockers.map((blocker) => blocker.label).join(", ") });
          return false;
        }
        const operationId = uuid();
        ownOperationIds.add(operationId);
        try {
          await api.installAgent(dbType, operationId);
        } finally {
          ownOperationIds.delete(operationId);
        }
      } else {
        return false;
      }
      // 更新成功后该组件已是最新，立即从列表移除；
      // 不必等外部再调 refreshAll 重新拉取（那要等 5 个 IPC 回来，行会多停留约 1 秒）
      items.value = items.value.filter((i) => i.id !== item.id);
      return true;
    } catch (e: any) {
      // 失败信息展示在列表上方，同时避免抛出未捕获的 Promise 异常
      error.value = e?.message ?? String(e);
      return false;
    } finally {
      item.updating = false;
    }
  }

  /**
   * "全部更新"：按"驱动 → 插件（MCP / JDBC / marketplace）→ DBX 本体"的顺序，
   * 逐个串行更新。一次只跑一个下载，避免并发抢占带宽和磁盘导致界面卡顿。
   * 单项失败不影响后续项，继续往下走。
   */
  async function updateAllAuto(): Promise<void> {
    if (allUpdating.value) return;
    const autoUpdatable = items.value.filter((i) => i.canAutoUpdate && i.hasUpdate);
    if (autoUpdatable.length === 0) return;
    allUpdating.value = true;
    error.value = "";
    try {
      const ordered = [...autoUpdatable].sort((a, b) => AUTO_UPDATE_ORDER[a.kind] - AUTO_UPDATE_ORDER[b.kind]);
      for (const item of ordered) {
        await updateItem(item.id);
      }
      void refreshAll();
    } catch (e: any) {
      // 兜底：updateItem 内部已捕获异常，这里防御顺序/排序等意外错误
      error.value = e?.message ?? String(e);
    } finally {
      allUpdating.value = false;
    }
  }

  /** 有可更新项目（extra items 里任何一项） */
  const hasAnyUpdate = computed(() => items.value.length > 0);

  /** 可自动更新项目数量（供 "全部更新" 按钮禁用判断） */
  const autoUpdateableCount = computed(() => items.value.filter((i) => i.canAutoUpdate).length);

  return {
    items,
    loading,
    error,
    allUpdating,
    refreshAll,
    updateItem,
    updateAllAuto,
    hasAnyUpdate,
    autoUpdateableCount,
  };
}

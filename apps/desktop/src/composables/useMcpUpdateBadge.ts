import { ref } from "vue";
import * as api from "@/lib/backend/api";
import { beginMcpStatusRequest, isLatestMcpStatusRequest, mcpUpdateAvailability } from "@/lib/mcp/mcpUpdateStatus";

interface UseMcpUpdateBadgeOptions {
  isDesktop: boolean;
  updateNotificationsEnabled: () => boolean;
  /**
   * 组件更新（尤其是 DBX 重启后自动执行的待更新计划）是 MCP 状态的权威来源。
   * 更新窗口内暂停后台轮询，避免旧快照在安装完成后把工具栏更新按钮重新点亮。
   */
  shouldDeferRefresh?: () => boolean;
}

/**
 * MCP server 更新徽章状态。
 *
 * 照搬 app/驱动两套 badge 模式：后台 silent 轮询 + computed 驱动红点 + 事件回传。
 * 通过递增请求序号忽略过期响应，避免“定时检查旧请求晚返回、覆盖升级后新结果”的竞态。
 */
export function useMcpUpdateBadge(options: UseMcpUpdateBadgeOptions) {
  const mcpUpdateAvailable = ref(false);

  async function refreshMcpUpdateStatus() {
    if (!options.isDesktop || !options.updateNotificationsEnabled()) return;
    // 预留序号并直接返回：组件更新结束后会由权威来源重新同步。
    if (options.shouldDeferRefresh?.()) {
      beginMcpStatusRequest();
      return;
    }
    const requestId = beginMcpStatusRequest();
    try {
      const status = await api.checkMcpServerStatus();
      if (!isLatestMcpStatusRequest(requestId)) return;
      if (!options.updateNotificationsEnabled()) return;
      const updateAvailable = mcpUpdateAvailability(status);
      if (updateAvailable !== null) mcpUpdateAvailable.value = updateAvailable;
    } catch {
      // MCP 状态仅作徽章提示；取不到就保持原值，不打扰用户。
    }
  }

  /**
   * EditorSettingsDialog 刷新/升级后通过事件回传已获取的 update_available，
   * 避免根组件重复查询 npm registry，同时使在途的定时检查失效。
   */
  function applyMcpStatus(updateAvailable: boolean, requestId?: number) {
    if (requestId !== undefined) {
      if (!isLatestMcpStatusRequest(requestId)) return;
    } else {
      beginMcpStatusRequest();
    }
    mcpUpdateAvailable.value = updateAvailable;
  }

  /**
   * 使在途的后台检查失效。安装开始/结束等权威状态切换点调用，防止较早发出的
   * 检查晚返回并覆盖已确认的结果。
   */
  function invalidateMcpUpdateStatus() {
    beginMcpStatusRequest();
  }

  function handleMcpStatusChanged(event: Event) {
    const detail = (event as CustomEvent<{ updateAvailable?: boolean | null; requestId?: number } | null | undefined>).detail;
    if (detail && typeof detail.updateAvailable === "boolean") {
      applyMcpStatus(detail.updateAvailable, detail.requestId);
    } else if (detail && typeof detail.requestId === "number") {
      return;
    } else {
      void refreshMcpUpdateStatus();
    }
  }

  return {
    mcpUpdateAvailable,
    refreshMcpUpdateStatus,
    handleMcpStatusChanged,
    applyMcpStatus,
    invalidateMcpUpdateStatus,
  };
}

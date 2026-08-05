import { ref } from "vue";
import * as api from "@/lib/backend/api";
import { beginMcpStatusRequest, isLatestMcpStatusRequest, mcpUpdateAvailability } from "@/lib/mcp/mcpUpdateStatus";

interface UseMcpUpdateBadgeOptions {
  isDesktop: boolean;
  updateNotificationsEnabled: () => boolean;
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
  };
}

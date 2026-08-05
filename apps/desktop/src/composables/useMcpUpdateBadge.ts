import { ref } from "vue";
import * as api from "@/lib/backend/api";

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
  // 失效令牌：每次发起检查递增；事件直接回传结果时也递增，使在途的过期响应被忽略。
  let mcpCheckSeq = 0;

  async function refreshMcpUpdateStatus() {
    if (!options.isDesktop || !options.updateNotificationsEnabled()) return;
    const seq = ++mcpCheckSeq;
    try {
      const status = await api.checkMcpServerStatus();
      if (seq !== mcpCheckSeq) return; // 忽略过期响应，防止 stale 覆盖
      if (!options.updateNotificationsEnabled()) return;
      mcpUpdateAvailable.value = !!status.update_available;
    } catch {
      // MCP 状态仅作徽章提示；取不到就保持原值，不打扰用户。
    }
  }

  /**
   * EditorSettingsDialog 刷新/升级后通过事件回传已获取的 update_available，
   * 避免根组件重复查询 npm registry，同时使在途的定时检查失效。
   */
  function applyMcpStatus(updateAvailable: boolean) {
    mcpCheckSeq++; // 使在途的定时检查失效
    mcpUpdateAvailable.value = updateAvailable;
  }

  function handleMcpStatusChanged(event: Event) {
    const detail = (event as CustomEvent<{ updateAvailable?: boolean } | null | undefined>).detail;
    if (detail && typeof detail.updateAvailable === "boolean") {
      applyMcpStatus(detail.updateAvailable);
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

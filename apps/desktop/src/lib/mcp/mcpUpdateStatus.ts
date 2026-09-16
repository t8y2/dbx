import type { McpServerStatus } from "@/lib/backend/tauri";

let mcpStatusRequestSequence = 0;
let latestMcpStatusRequestId = 0;

export function beginMcpStatusRequest(): number {
  latestMcpStatusRequestId = ++mcpStatusRequestSequence;
  return latestMcpStatusRequestId;
}

export function isLatestMcpStatusRequest(requestId: number): boolean {
  return requestId === latestMcpStatusRequestId;
}

export function mcpUpdateAvailability(status: McpServerStatus): boolean | null {
  if (!status.installed) return false;
  if (!status.current_version || !status.latest_version) return null;
  return status.update_available;
}

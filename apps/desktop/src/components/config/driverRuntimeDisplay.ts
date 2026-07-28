import type { DriverRuntimeInfo } from "@/lib/backend/tauri";

export function driverRuntimeProtocolLabel(runtime: Pick<DriverRuntimeInfo, "protocol_mode" | "active_sessions">): string | null {
  if (runtime.protocol_mode === "multi_session") {
    return `Multi-session · ${runtime.active_sessions ?? 0} sessions`;
  }
  if (runtime.protocol_mode === "legacy") {
    return "Legacy";
  }
  return null;
}

export interface RocketMqChannelState {
  channel: "messaging" | "management";
  status: "ready" | "disabled" | "degraded";
  error?: string;
}
export function resolveRocketMqChannels(extra: unknown): RocketMqChannelState[] {
  if (!extra || typeof extra !== "object" || !("channels" in extra)) return [];
  const channels = extra.channels;
  if (!channels || typeof channels !== "object") return [];
  return (["messaging", "management"] as const).flatMap((channel) => {
    const state = (channels as Record<string, unknown>)[channel];
    if (!state || typeof state !== "object" || !("status" in state)) return [];
    const status = state.status;
    if (status !== "ready" && status !== "disabled" && status !== "degraded") return [];
    const error = "error" in state && typeof state.error === "string" ? state.error : undefined;
    return [{ channel, status, error }];
  });
}

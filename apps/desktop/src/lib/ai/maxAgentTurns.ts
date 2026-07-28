// Mirrors DEFAULT/MIN/MAX_MAX_AGENT_TURNS in crates/dbx-core/src/agent_loop.rs.
// The backend clamp remains the source of truth for persisted values.
export const MAX_AGENT_TURNS_DEFAULT = 30;
export const MAX_AGENT_TURNS_MIN = 5;
export const MAX_AGENT_TURNS_MAX = 500;

export function maxAgentTurnsOutOfRange(value: number | undefined): boolean {
  return typeof value === "number" && (value < MAX_AGENT_TURNS_MIN || value > MAX_AGENT_TURNS_MAX);
}

export function normalizeMaxAgentTurns(value: number | undefined): number {
  const rounded = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : MAX_AGENT_TURNS_DEFAULT;
  return Math.min(MAX_AGENT_TURNS_MAX, Math.max(MAX_AGENT_TURNS_MIN, rounded));
}

/**
 * Wire shape of one host observation event.
 *
 * Mirrors `dbx_types::models::observability::HostObservationEvent` (camelCase).
 * Events are produced by the Rust taps (query execution, connection lifecycle,
 * AI agent loop, transfers, plugin lifecycle) and delivered to plugin UIs via
 * the `dbx-host-observation` Tauri event before each bridge filters them by
 * the `host.observe:*` permissions of its own manifest.
 */
export interface PluginHostObservationEvent {
  /** Monotonic per host process; gaps reveal dropped events. */
  id: number;
  /** Wall-clock epoch milliseconds. */
  tsMs: number;
  /** Dotted kind, e.g. `query.finished`. The prefix selects the permission. */
  kind: string;
  connectionId?: string;
  database?: string;
  payload: unknown;
}

/** Tauri event name carrying host observation events. */
export const HOST_OBSERVATION_EVENT = "dbx-host-observation";

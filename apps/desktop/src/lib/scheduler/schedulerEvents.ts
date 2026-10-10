// ---------------------------------------------------------------------------
// Scheduler event subscription (ADR §7.4). Desktop listens on the Tauri
// `dbx-scheduler-event`; the browser runtime consumes the SSE endpoint. Events
// are notifications only — after (or instead of) handling one, callers refetch
// the affected entities from the API so a dropped event never leaves stale UI.
// ---------------------------------------------------------------------------

import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { apiUrl } from "@/lib/common/webPath";
import { SCHEDULER_EVENT_NAME, type SchedulerEvent } from "./schedulerTypes";

export async function subscribeSchedulerEvents(onEvent: (event: SchedulerEvent) => void): Promise<() => void> {
  if (isTauriRuntime(globalThis)) {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<SchedulerEvent>(SCHEDULER_EVENT_NAME, (event) => onEvent(event.payload));
    return unlisten;
  }
  const source = new EventSource(apiUrl("/api/scheduler/events"));
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as SchedulerEvent);
    } catch {
      // Malformed notifications are dropped; the API remains the source of truth.
    }
  };
  return () => source.close();
}

export const COMPONENT_PLUGINS_UPDATED_EVENT = "dbx:component-plugins-updated";
export const COMPONENT_UPDATES_CHANGED_EVENT = "dbx:component-updates-changed";

export function notifyComponentPluginsUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COMPONENT_PLUGINS_UPDATED_EVENT));
}

export function notifyComponentUpdatesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COMPONENT_UPDATES_CHANGED_EVENT));
}

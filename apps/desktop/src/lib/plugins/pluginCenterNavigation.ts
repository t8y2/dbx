import type { InjectionKey } from "vue";

export const OPEN_PLUGIN_SETTINGS: InjectionKey<() => void> = Symbol("open-plugin-settings");

export interface PluginCenterFocus {
  section?: "settings";
  pluginId?: string;
  providerId?: string;
}

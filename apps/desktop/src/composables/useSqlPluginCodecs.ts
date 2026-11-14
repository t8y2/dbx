import { onScopeDispose, shallowRef } from "vue";
import * as api from "@/lib/backend/api";
import { listSqlPluginCodecs } from "@/lib/dataGrid/sqlPluginCodec";
import type { PluginValueCodec } from "@/lib/plugins/pluginValueCodec";

/** Installed SQL value codecs. Listing plugins never sends a cell value. */
export function useSqlPluginCodecs() {
  const codecs = shallowRef<PluginValueCodec[]>([]);
  const loading = shallowRef(false);
  let disposed = false;

  async function refresh() {
    loading.value = true;
    try {
      const available = listSqlPluginCodecs(await api.listPlugins());
      if (!disposed) codecs.value = available;
    } catch {
      // Keep the previous list: a transient failure should not hide installed codecs.
    } finally {
      if (!disposed) loading.value = false;
    }
  }

  // Plugin install/update/uninstall from the Plugin Center broadcasts this event.
  const onPluginsChanged = () => void refresh();
  window.addEventListener("dbx:plugins-changed", onPluginsChanged);
  onScopeDispose(() => {
    disposed = true;
    window.removeEventListener("dbx:plugins-changed", onPluginsChanged);
  });
  void refresh();

  return { codecs, loading, refresh };
}

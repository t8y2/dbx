import { Channel, invoke } from "@tauri-apps/api/core";
import type { PluginDownloadRequest, PluginSaveFileResult } from "./pluginHostBridge";

export async function downloadPluginFile(pluginId: string, request: PluginDownloadRequest, onProgress: (progress: unknown) => void): Promise<PluginSaveFileResult | null> {
  const channel = new Channel<unknown>();
  channel.onmessage = onProgress;
  const path = await invoke<string | null>("download_plugin_file", {
    pluginId,
    downloadId: request.downloadId,
    fileName: request.fileName || "download.bin",
    params: request.params,
    onProgress: channel,
  });
  return path === null ? null : { path };
}

export async function cancelPluginDownload(pluginId: string, downloadId: string): Promise<void> {
  await invoke("cancel_plugin_download", { pluginId, downloadId });
}

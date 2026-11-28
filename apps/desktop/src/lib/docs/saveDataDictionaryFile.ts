import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { DICTIONARY_EXPORT_FORMATS, type DictionaryExportFormat } from "./dataDictionary";

export class DictionaryFileExistsError extends Error {
  constructor() {
    super("exists");
    this.name = "DictionaryFileExistsError";
  }
}

export async function chooseDataDictionaryPath(suggestedName: string, format: DictionaryExportFormat = "pdf"): Promise<string | null> {
  if (!isTauriRuntime()) return suggestedName;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: suggestedName, filters: [{ name: DICTIONARY_EXPORT_FORMATS[format].label, extensions: [format] }] });
}

/**
 * Suggested name is only the save dialog's defaultPath. The write uses the path
 * `save()` just returned. Tauri's dialog grant covers that exact path, not a
 * typed path or a timestamp appended after the dialog closes.
 */
export async function saveDataDictionaryFile(suggestedName: string, content: Uint8Array, options: { overwrite: boolean; grantedPath?: string; format?: DictionaryExportFormat }): Promise<string | null> {
  const format = options.format ?? "pdf";
  if (isTauriRuntime()) {
    const fs = await import("@tauri-apps/plugin-fs");
    const granted = options.grantedPath ?? (await chooseDataDictionaryPath(suggestedName, format));
    if (!granted) return null;
    if (!options.overwrite && (await fs.exists(granted))) throw new DictionaryFileExistsError();
    await fs.writeFile(granted, content);
    return granted;
  }

  const downloadName = suggestedName.split(/[/\\]/).pop() || suggestedName;
  const blob = new Blob([content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer], { type: DICTIONARY_EXPORT_FORMATS[format].mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadName;
  anchor.click();
  URL.revokeObjectURL(url);
  return downloadName;
}

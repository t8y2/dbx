import { saveTextFile, sanitizeExportBaseName } from "@/lib/export/saveTextFile";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { DataView } from "@/types/dataView";

const EXPORT_FORMAT = "dbx-data-view";
const EXPORT_VERSION = 1;

export interface DataViewExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  dataView: DataView;
}

export function buildDataViewExportFile(view: DataView): DataViewExportFile {
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), dataView: view };
}

/** Basic shape guard for untrusted file content; throws a descriptive error rather than letting bad data reach the store. */
export function parseDataViewImportFile(content: string): DataView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).format !== EXPORT_FORMAT) {
    throw new Error("Not a valid dbx data view export file");
  }
  const dataView = (parsed as Record<string, unknown>).dataView;
  if (typeof dataView !== "object" || dataView === null) throw new Error("Not a valid dbx data view export file");
  const { name, queries, variables } = dataView as Record<string, unknown>;
  if (typeof name !== "string" || !Array.isArray(queries) || !Array.isArray(variables)) throw new Error("Not a valid dbx data view export file");
  return dataView as DataView;
}

export async function exportDataView(view: DataView): Promise<void> {
  const json = JSON.stringify(buildDataViewExportFile(view), null, 2);
  const fileName = `${sanitizeExportBaseName(view.name) || "data-view"}.json`;
  await saveTextFile(json, fileName, "JSON", "json");
}

/** Opens a file picker (Tauri dialog vs. browser `<input type=file>`) and returns the file's text, or null if cancelled. */
export async function readDataViewImportFile(): Promise<string | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ filters: [{ name: "DBX Data View", extensions: ["json"] }], multiple: false });
    if (!path) return null;
    return readTextFile(path as string);
  }

  return new Promise<string | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}

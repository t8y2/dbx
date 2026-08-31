import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { diagramExportDialogFilter, type DiagramExportFormat } from "./diagramFormats";

export async function saveDiagramTextExport(defaultPath: string, content: string, format: DiagramExportFormat): Promise<boolean> {
  if (isTauriRuntime()) {
    const [{ save }, { writeTextFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({
      defaultPath,
      filters: [diagramExportDialogFilter(format)],
    });
    if (!path) return false;
    await writeTextFile(path, content);
    return true;
  }

  const mime = format === "svg" ? "image/svg+xml" : format === "json" ? "application/json" : "text/plain";
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultPath;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

export async function saveDiagramBinaryExport(defaultPath: string, data: Blob, format: DiagramExportFormat): Promise<boolean> {
  if (isTauriRuntime()) {
    const [{ save }, { writeFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({
      defaultPath,
      filters: [diagramExportDialogFilter(format)],
    });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await data.arrayBuffer()));
    return true;
  }

  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultPath;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

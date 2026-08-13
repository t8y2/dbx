import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { ensureSqlExtension } from "@/lib/savedSql/savedSqlFileName";

export function savedSqlExportFileName(name: string): string {
  return (
    ensureSqlExtension(name)
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
      .trim() || "untitled.sql"
  );
}

export async function exportSavedSqlFileContent(sql: string, fileName: string): Promise<"saved" | "cancelled"> {
  const defaultFileName = savedSqlExportFileName(fileName);
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultFileName,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!path) return "cancelled";
    await writeTextFile(path, sql);
    return "saved";
  }

  const blob = new Blob([sql], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultFileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return "saved";
}

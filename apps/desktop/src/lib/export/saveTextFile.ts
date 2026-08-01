import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export async function saveTextFile(content: string, defaultFileName: string, filterName: string, filterExt: string) {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultFileName,
      filters: [{ name: filterName, extensions: [filterExt] }],
    });
    if (path) await writeTextFile(path, content);
    return;
  }

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultFileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function sanitizeExportBaseName(value: string): string {
  return replaceControlCharacters(
    value
      .trim()
      .replace(/\.[sS][qQ][lL]$/, "")
      .replace(/[<>:"/\\|?*]/g, "_"),
    "_",
  )
    .replace(/\s+/g, " ")
    .replace(/[._\s-]+$/g, "")
    .slice(0, 120);
}

function replaceControlCharacters(value: string, replacement: string): string {
  return Array.from(value)
    .map((char) => (char.charCodeAt(0) < 32 ? replacement : char))
    .join("");
}

export function compactLocalTimestamp(date = new Date()): string {
  const yy = String(date.getFullYear() % 100).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${yy}${month}${day}${hour}${minute}${second}`;
}

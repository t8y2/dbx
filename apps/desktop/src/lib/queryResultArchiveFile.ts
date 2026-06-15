import { isTauriRuntime } from "@/lib/tauriRuntime";

const ARCHIVE_MIME_TYPE = "application/vnd.dbx.results";
const ARCHIVE_EXTENSIONS = ["dbxresults"];

function downloadArchiveFile(fileName: string, bytes: Uint8Array): string {
  const blob = new Blob([bytes.slice().buffer], { type: ARCHIVE_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return fileName;
}

function openArchiveFileInBrowser(): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".dbxresults,application/octet-stream,application/vnd.dbx.results";
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) {
          resolve(undefined);
          return;
        }
        resolve(new Uint8Array(await file.arrayBuffer()));
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

export async function saveQueryResultArchiveFile(fileName: string, bytes: Uint8Array): Promise<string | undefined> {
  if (!isTauriRuntime()) return downloadArchiveFile(fileName, bytes);

  const [{ save }, { writeFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const path = await save({
    defaultPath: fileName,
    filters: [{ name: "DBX Result Archive", extensions: ARCHIVE_EXTENSIONS }],
  });
  if (!path) return undefined;
  await writeFile(path, bytes);
  return path;
}

export async function openQueryResultArchiveFile(): Promise<Uint8Array | undefined> {
  if (!isTauriRuntime()) return openArchiveFileInBrowser();

  const [{ open }, { readFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const selected = await open({
    multiple: false,
    filters: [{ name: "DBX Result Archive", extensions: ARCHIVE_EXTENSIONS }],
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return undefined;
  return readFile(path);
}

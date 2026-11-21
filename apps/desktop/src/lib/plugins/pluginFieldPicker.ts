import type { PluginFormFieldPicker } from "@/types/database";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/** Uploads larger than this are rejected instead of being held in memory. */
export const PLUGIN_PICKER_MAX_BYTES = 1_048_576;

export interface PluginPickedFile {
  /** Absolute path of the selected file; desktop hosts only. */
  path?: string;
  /** File content; browser hosts only (they cannot produce a usable path). */
  content?: string;
  /** File name, for messages. */
  name: string;
}

/**
 * Runs the manifest's picker action for one field.
 *
 * Desktop hosts (Tauri) open the native dialog and return the absolute path, so
 * the plugin — which runs on the same machine — can read the file itself.
 * Browser hosts have no client filesystem: they read the selected file and hand
 * back its content, which the form stores in the declared `content_field`
 * (the browser build cannot hand the server a path to a client file).
 *
 * Returns `null` when the user cancels.
 */
export async function pickPluginFieldFile(picker: PluginFormFieldPicker): Promise<PluginPickedFile | null> {
  const accepted = (picker.accept || []).slice();
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const extensions = accepted.filter((entry) => entry.startsWith(".")).map((entry) => entry.replace(/^\./, ""));
    const selected = await open({
      directory: picker.kind === "directory",
      multiple: false,
      filters: extensions.length ? [{ name: picker.kind === "directory" ? "Folders" : "Files", extensions }] : undefined,
    });
    if (typeof selected !== "string" || !selected) return null;
    return { path: selected, name: selected.replaceAll("\\", "/").split("/").pop() || selected };
  }

  if (picker.kind === "directory") return null;
  const file = await selectBrowserFile(accepted);
  if (!file) return null;
  if (file.size > PLUGIN_PICKER_MAX_BYTES) {
    throw new Error(`File is larger than ${Math.round(PLUGIN_PICKER_MAX_BYTES / 1024)} KiB`);
  }
  return { content: await file.text(), name: file.name };
}

function selectBrowserFile(accept: string[]): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = false;
    if (accept.length) input.accept = accept.join(",");
    // Chrome fires `cancel` when the dialog is dismissed; older engines only
    // fire `change` without files, which the handler below already treats as a
    // cancellation.
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.addEventListener(
      "change",
      () => {
        resolve(input.files?.[0] ?? null);
      },
      { once: true },
    );
    input.click();
  });
}

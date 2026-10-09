import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/** Commands supported by CodeMirror Vim are read from the desktop user's file. */
export function parseVimConfig(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('"'));
}

// CodeMirror Vim stores mappings globally. Applying one on every tab would
// keep prepending duplicate mappings to its shared keymap.
export function isVimMappingCommand(command: string): boolean {
  return /^(?:[niv]?noremap|[niv]?map|[niv]?unmap|[niv]?mapclear)(?:\s|$|!)/.test(command);
}

let loading: Promise<string[]> | null = null;

/** Read once per app session; a restart picks up edits to ~/.dbx/vimrc. */
export function loadVimConfig(): Promise<string[]> {
  loading ??= (async () => {
    if (!isTauriRuntime()) return [];
    try {
      const { homeDir, join } = await import("@tauri-apps/api/path");
      const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
      const file = await join(await homeDir(), ".dbx", "vimrc");
      if (!(await exists(file))) return [];
      return parseVimConfig(await readTextFile(file));
    } catch (error) {
      console.warn("[vim-config] could not read ~/.dbx/vimrc", error);
      return [];
    }
  })();
  return loading;
}

/** A bad command must not prevent the remaining commands or editor startup. */
export function applyVimConfig(commands: readonly string[], execute: (command: string) => void): void {
  for (const command of commands) {
    try {
      execute(command);
    } catch (error) {
      console.warn(`[vim-config] ignored command: ${command}`, error);
    }
  }
}

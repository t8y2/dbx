import { homedir, platform } from "node:os";
import { join, posix, win32 } from "node:path";

export function appDataDir(): string {
  // 支持 DBX_DATA_DIR 环境变量（与 Rust 侧 data_dir.rs 保持一致）
  return appDataDirFromInputs({
    platform: platform(),
    home: homedir(),
    appData: process.env.APPDATA,
    envDataDir: process.env.DBX_DATA_DIR,
  });
}

export function appDataDirFromInputs(options: { platform: NodeJS.Platform; home: string; appData?: string; envDataDir?: string }): string {
  if (options.envDataDir && options.envDataDir.trim() !== "") {
    return options.envDataDir;
  }

  switch (options.platform) {
    case "darwin":
      return posix.join(options.home, "Library", "Application Support", "com.dbx.app");
    case "win32":
      return win32.join(options.appData || win32.join(options.home, "AppData", "Roaming"), "com.dbx.app");
    default:
      return posix.join(options.home, ".local", "share", "com.dbx.app");
  }
}

export function dbPath(): string {
  return join(appDataDir(), "dbx.db");
}

export function bridgePortFilePath(): string {
  return join(appDataDir(), "mcp-bridge-port");
}

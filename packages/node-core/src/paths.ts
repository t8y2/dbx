import { homedir, platform } from "node:os";
import { join } from "node:path";

export function appDataDir(): string {
  // 支持 DBX_DATA_DIR 环境变量（与 Rust 侧 data_dir.rs 保持一致）
  const envDir = process.env.DBX_DATA_DIR;
  if (envDir && envDir.trim() !== "") {
    return envDir;
  }

  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "com.dbx.app");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "com.dbx.app");
    default:
      return join(home, ".config", "com.dbx.app");
  }
}

export function dbPath(): string {
  return join(appDataDir(), "dbx.db");
}

export function bridgePortFilePath(): string {
  return join(appDataDir(), "mcp-bridge-port");
}

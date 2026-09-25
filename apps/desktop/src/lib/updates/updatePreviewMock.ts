import type { UpdateInfo } from "@/lib/backend/api";
import type { AgentDriverInfo, McpServerStatus } from "@/lib/backend/tauri";
import type { JdbcPluginStatus } from "@/types/database";
import type { MarketplacePluginListing } from "@/lib/plugins/pluginMarketplace";

export function isUpdatePreviewMockEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_DBX_MOCK_UPDATES === "1";
}

export function previewAppUpdateInfo(currentVersion: string): UpdateInfo {
  const current = currentVersion || "0.6.15";
  const showAppUpdate = import.meta.env.VITE_DBX_MOCK_UPDATE_SCENARIO !== "components";
  return {
    current_version: current,
    latest_version: showAppUpdate ? "0.6.16" : current,
    update_available: showAppUpdate,
    portable_mode: false,
    manual_update_only: false,
    release_name: showAppUpdate ? "DBX v0.6.16 Preview" : `DBX v${current}`,
    release_url: "https://github.com/t8y2/dbx/releases",
    release_notes: showAppUpdate
      ? `## 更新预览

### 新功能
- 更新中心集中展示 DBX、驱动、JDBC、MCP 与插件更新
- 支持按更新类别查看版本信息和更新内容

### 修复
- 优化自动更新开关默认值
- 修复独立入口红点与聚合更新状态不一致的问题

### 体验优化
- 更新检查在后台静默执行
- 组件更新仅在无阻塞任务时安装`
      : "",
  };
}

export function previewDriverUpdates(): AgentDriverInfo[] {
  const fixtures = [
    ["mysql", "MySQL", "8.0.35", "9.0.1", 18_400_000],
    ["postgresql", "PostgreSQL", "16.2", "17.0", 15_800_000],
    ["oracle", "Oracle", "23.4.0", "23.5.0", 42_600_000],
    ["sqlserver", "SQL Server", "12.8.1", "13.0.2", 21_300_000],
    ["mariadb", "MariaDB", "3.3.7", "3.4.1", 12_900_000],
    ["dameng", "达梦 DM8", "8.1.3.100", "8.1.3.140", 26_700_000],
    ["kingbase", "KingbaseES", "9.1.0", "9.2.0", 24_500_000],
    ["tdengine", "TDengine", "3.3.5", "3.3.7", 31_200_000],
    ["clickhouse", "ClickHouse", "0.8.5", "0.8.6", 17_600_000],
    ["mongodb", "MongoDB", "5.4.0", "5.5.1", 19_800_000],
    ["redis", "Redis", "1.7.0", "1.8.0", 9_400_000],
    ["db2", "DB2", "12.1.0", "12.1.2", 28_100_000],
  ] as const;
  return fixtures.map(([db_type, label, installed_version, version, size]) => ({
    db_type,
    label,
    version,
    size,
    installed: true,
    installed_version,
    update_available: true,
    requires_java_runtime: true,
    jre: "21",
    jre_installed: true,
  }));
}

export function previewJdbcUpdate(): JdbcPluginStatus {
  return {
    installed: true,
    version: "0.1.0",
    protocol_version: 1,
    compatible: true,
    latest_version: "0.2.0",
    latest_protocol_version: 2,
    update_available: true,
    path: "/preview/jdbc-agent",
  };
}

export function previewMcpUpdate(): McpServerStatus {
  return {
    installed: true,
    npm_available: true,
    node_path: "/preview/bin/node",
    node_version: "v22.18.0",
    current_version: "0.4.88",
    latest_version: "0.4.89",
    update_available: true,
    bin_path: "/preview/bin/dbx-mcp",
    native_bin_path: null,
    script_path: "/preview/lib/dbx-mcp/index.js",
    data_dir: "/preview/data/mcp",
    install_command: "npm install -g @dbx-app/mcp-server",
    update_command: "npm update -g @dbx-app/mcp-server",
    uninstall_command: "npm uninstall -g @dbx-app/mcp-server",
    error: null,
  };
}

export function previewPluginUpdates(): MarketplacePluginListing[] {
  return [
    {
      key: "official:io.dbx.ssh",
      repository: { id: "official", name: "DBX Official", kind: "official", enabled: true, managed: true },
      plugin: {
        id: "io.dbx.ssh",
        name: "SSH Tunnel",
        description: "通过 SSH 隧道安全访问数据库。",
        publisher: "DBX",
        verified: true,
        tags: ["ssh", "tunnel"],
        permissions: ["network"],
        latestVersion: "0.4.78",
        versions: [],
      },
      name: "SSH Tunnel",
      description: "通过 SSH 隧道安全访问数据库。",
      target: "universal",
      artifact: { target: "universal", url: "https://example.invalid/ssh.dbxp", sha256: "preview", signingKeyId: "preview" },
      installed: { manifest: { id: "io.dbx.ssh", name: "SSH Tunnel", version: "0.4.77", drivers: [] }, compatibility: { compatible: true } },
      verified: true,
      status: "update",
    },
    {
      key: "official:io.dbx.data-tools",
      repository: { id: "official", name: "DBX Official", kind: "official", enabled: true, managed: true },
      plugin: {
        id: "io.dbx.data-tools",
        name: "Data Tools",
        description: "数据生成、转换和校验工具集。",
        publisher: "DBX",
        verified: true,
        tags: ["data", "tools"],
        permissions: ["database"],
        latestVersion: "3.3.0",
        versions: [],
      },
      name: "Data Tools",
      description: "数据生成、转换和校验工具集。",
      target: "universal",
      artifact: { target: "universal", url: "https://example.invalid/data-tools.dbxp", sha256: "preview", signingKeyId: "preview" },
      installed: { manifest: { id: "io.dbx.data-tools", name: "Data Tools", version: "3.2.0", drivers: [] }, compatibility: { compatible: true } },
      verified: true,
      status: "update",
    },
  ];
}

# 在 Codex 中使用 DBX

插件内含原生 `dbx-codex` MCP 网关、`dbx-web` 和嵌入式前端。Codex 连接插件时自动启动本地工作台，无需启动 DBX 桌面端，也无需安装 Node.js、Rust 或 Docker。

工作台复用完整 DBX Web 界面和数据库执行后端。数据库服务器、独立驱动代理、系统库或云服务等功能原有的外部依赖仍然适用。

## 安装

选择匹配操作系统与 CPU 的压缩包，核对 `SHA256SUMS` 后解压到固定目录。解压内容包括 `plugins/dbx` 和隐藏目录 `.agents/plugins/marketplace.json`，移动时需一并保留。

```sh
codex plugin marketplace add /解压目录的绝对路径
codex plugin add dbx@dbx-local
```

按 Codex 提示启用插件；已有会话可能需要重新建立 MCP 连接才会加载工具。让 Codex 打开 DBX，调用 `dbx_codex_open`，将返回网址打开到 Codex 浏览器面板。首次使用设置工作台密码、完成原有安全迁移，再添加数据库连接并设置 MCP 权限。

`dbx_codex_open_table` 打开表；`dbx_codex_execute_and_show` 通过现有 MCP 批量执行器执行 SQL，并显示同一次执行的原始结果。打开链接不会重跑 SQL。链接五分钟后或服务重启后失效，不能为了恢复写入结果而再次执行写入。

关闭面板或断开单个 MCP 客户端不会停止共享服务。`dbx_codex_status` 返回实例与可跟踪活动；活动统计不完整，零任务不代表空闲。停止服务必须明确授权中断所有客户端及进行中的工作，随后调用 `dbx_codex_stop(confirm_interrupt=true)`。停止或卸载插件不会删除持久化数据。

## 数据与运行边界

默认目录与桌面端隔离：macOS 为 `~/Library/Application Support/com.dbx.codex`，Linux 为 `$XDG_DATA_HOME/com.dbx.codex`（通常是 `~/.local/share/com.dbx.codex`），Windows 为 `%LOCALAPPDATA%\com.dbx.codex`。可在启动 Codex 前设置绝对路径环境变量 `DBX_CODEX_DATA_DIR`。备份应包含整个目录和加密密钥，不能只复制连接记录。

服务仅监听 `127.0.0.1` 的动态端口。Web 使用密码与会话认证；数据库 MCP 在密码设置及迁移完成前不可用。MCP 与生命周期接口由私有令牌保护，并校验 Host/Origin；本地文件使用 Unix 私有权限或 Windows 受保护 ACL。不要将监听地址通过代理公开，也不要与不可信本地用户共享数据目录。分享目录中的 `workbench.log` 前应检查内容。

## 开发与验证

| 能力 | Codex 中的行为 |
| --- | --- |
| 连接、SQL 编辑/执行/取消、历史、权限、表分页与编辑 | 复用现有 Web/HTTP/core 实现，与 MCP 共用持久化连接 |
| MCP 打开表与原始查询结果 | 新增不透明导航标识，不重跑 SQL |
| 导入导出、SQL 上传下载、SQLite 路径 | 沿用 Web 流程；路径属于本地后端主机，下载由浏览器处理 |
| Redis、MongoDB 及其他数据库 | 沿用 Web 适配器，仍需对应服务器和凭据 |
| 驱动管理和 DBX 插件中心 | 沿用 Web 能力，需要时另装驱动代理/JRE/系统依赖 |
| 外部 SQL 文件夹监视/编辑、桌面深链、原生更新 | 原有 Web 限制，桌面专属 API 明确报告不可用；本插件通过 Codex/原生产物更新 |
| 第三方 DBX 插件的原生 UI/存储/媒体 API | Web 后端未提供桌面专属 API，需逐个核对插件兼容性 |

本次增加完整 Web 工作台的独立运行方式；桌面专属能力仍遵循原有 Web 边界。打包端到端脚本实测 SQLite 和插件生命周期，共享功能由仓库 Web/MCP/前端回归覆盖，并未对所有外部数据库及第三方插件逐一进行真实连接测试。

构建需要 Node.js 24+、pnpm、Rust 及仓库原生构建依赖；运行成品不需要这些开发工具。

```sh
pnpm install --frozen-lockfile
pnpm --filter @dbx-app/mongo-shell build
pnpm build
cargo build --locked --release -p dbx-codex -p dbx-web --features dbx-web/codex-plugin
node scripts/package-codex-plugin.mjs --target aarch64-apple-darwin --binaries target/release --output target/codex-plugin/local
node --test scripts/package-codex-plugin.test.mjs
node scripts/verify-codex-plugin.mjs --plugin-dir target/codex-plugin/local/plugins/dbx
```

目标需改为本机平台。打包器校验两个程序版本、嵌入式资源和完整默认后端功能，拒绝覆盖已有输出。调试构建同样必须使用 `codex-plugin` 功能，仅 `embed-static` 不足以独立运行。验收脚本创建独立临时 SQLite 数据，检查权限、原始结果、共享生命周期及重启保留，然后停止自己的服务。加 `--keep-running` 可保留测试服务用于界面验收，测试密码为 `DBX-native-acceptance-only-42!`，不能用于真实数据。

手动触发 **Codex Plugin Native Artifacts** 工作流会在 macOS、Linux、Windows 的 x64/ARM64 原生 runner 上构建、测试并上传压缩包与校验和，不自动发布 Release。当前本地实测为 macOS ARM64；Windows ACL 测试仅完成本地交叉编译，其余平台必须通过原生 CI 后才能分发。当前产物为未签名开发包，正式签名与发布由维护者决定。

完整英文说明见 [README.md](README.md)。此方案通过本地 Codex marketplace 安装，未提交 OpenAI 公共插件目录。

# DBX 数据安全升级与迁移

本文档记录 DBX Secret Store、历史数据迁移、跨平台同步和启动向导的设计与实现，供用户排障和后续开发维护使用。

## 1. 为什么需要这次升级

新版本将连接、插件、AI、Tunnel 和同步相关的敏感配置统一交给 Secret Store 保护。升级后的第一次启动会检查当前数据目录：如果发现仍有需要处理的数据，DBX 会在进入主界面前显示“数据安全升级”向导。

这不是每次启动都要执行的操作。迁移成功后，后续启动会直接进入 DBX；迁移备份可以在确认连接正常后由用户主动清理。

## 2. 密钥边界

DBX 使用两套互相独立的密钥体系：

| 用途 | 密钥来源 | 作用 | 是否跨设备 |
| --- | --- | --- | --- |
| 本地存储密钥 | 桌面系统凭据库、Web 数据目录托管密钥，或 `DBX_SECRET_KEY(_FILE)` | 保护当前设备 `dbx.db` 中的 Secret Store 密文 | 不通过同步传输 |
| 同步口令 | 用户在导出/导入时主动输入 | 保护跨平台同步包中的敏感 payload | 随加密同步包使用 |

本地密钥不会写入同步文件，也不能通过复制 `dbx.db` 迁移到另一台设备。跨平台迁移必须使用加密导出/导入。

本地 Secret Store 使用 `dbxenc1` 密文封装、AES-256-GCM 和绑定命名空间/字段名的 AAD。同步包使用独立的同步加密格式和同步口令，不能直接复用本地密文。

## 3. 支持范围

### 桌面端

- macOS：使用 Keychain；必要时使用受限权限的兼容密钥文件。
- Windows：使用 Credential Manager。
- Linux：使用 Secret Service；无可用平台存储时，迁移向导会提示配置持久化密钥。
- 向导阻止进入主界面，直到迁移完成或确认当前数据不需要迁移。

### Web、Docker、CLI 和 MCP

`dbx-web` 无论通过 Docker、systemd 还是直接运行二进制，默认都使用 `${DBX_DATA_DIR}/.dbx/secret.key`。只有在开始迁移或第一次写入敏感字段时才创建该密钥，并使用受限权限。它与 `dbx.db` 属于同一恢复单元，必须一起备份和恢复；数据目录内密钥不能防护整个数据卷被复制或泄露。

生产环境可以改用外部托管密钥：

```text
DBX_SECRET_KEY_FILE=/run/secrets/dbx_secret_key
```

也可以由密钥管理系统提供 `DBX_SECRET_KEY`。显式配置优先；显式密钥不可读或格式错误时不会回退到数据目录密钥。已有密文使用期间不能更换密钥。

CLI/MCP 启动检查只读取现有密钥，不自动生成密钥，也不自动迁移历史数据。返回 `DATA_MIGRATION_REQUIRED` 时，应先使用桌面端或 Web 向导完成迁移。

## 4. 启动与迁移状态机

存储启动拆分为三个阶段：

```text
open_unmigrated()
  -> 打开 SQLite、初始化必要 schema，不迁移历史数据

inspect_data_migration()
  -> 只读扫描数据库、JSON 文件和密钥提供者

start_data_migration()/retry_data_migration()
  -> 备份、迁移、验证、记录最终状态
```

状态记录在 `data_migrations` 表中，固定迁移 ID 为 `secret-store-v1`：

- `pending`：等待用户开始或等待修复环境。
- `running`：正在备份或迁移。
- `failed`：迁移失败，原始数据和备份保留，可以重试。
- `succeeded`：迁移成功，后续启动直接进入主界面。
- `not_required`：没有需要迁移的数据。

扫描统计带有独立的源数据指纹。迁移状态变化时旧扫描缓存会失效，避免把迁移前的敏感项数量误用于迁移后的状态判断。

## 5. 迁移流程

### 5.1 预检查

预检查只返回数量、状态、非敏感的密钥来源名称和文件名，不返回密码、Token、私钥、密钥内容或密钥路径。已有密文时会验证当前密钥能否解密，绝不会生成替代密钥。检查内容包括：

- 连接和 `connection_secrets` 中的待处理项。
- 插件 secret、AI secret、Tunnel secret 和同步凭据。
- 历史 JSON 文件是否存在。
- 本机或外部密钥是否可用。
- 是否需要创建备份。

### 5.2 创建备份

迁移前创建权限受限的目录：

```text
dbx-secret-migration-<uuid>/
```

目录中包含 SQLite 一致性备份以及存在的历史 JSON 文件。SQLite 使用备份 API，避免只复制主数据库而遗漏 WAL 状态。备份创建失败时不会开始迁移。

### 5.3 数据迁移

迁移在目标设备的本地 Secret Store 下执行：

1. 连接密码、SSH 密码和私钥口令写入对应 Secret Store 命名空间。
2. 插件 `binding: "secret"` 字段写入 `plugin_connection.<field>` 命名空间。
3. AI、Tunnel、WebDAV 和代码托管凭据写入对应全局命名空间。
4. 公开配置 JSON 只保留非敏感字段。
5. 数据库写入使用事务；后续 JSON 解析或验证失败时恢复数据库备份。

历史 JSON 遵循“导入、验证、最后改名”顺序。成功后才改名为 `.bak`；解析失败时原文件保持不变，方便修复后重试。

### 5.4 验证

提交后验证：

- 旧明文列为空。
- 敏感字段具备 `dbxenc1` 密文。
- 所有密文可以使用当前设备密钥解密。
- 连接、AI、Tunnel 和插件公开 JSON 不含敏感字段。
- `save_password=false` 的连接不会重新获得主密码。
- 历史 JSON 只有在验证成功后才改名。

任一验证失败都会保留原始备份并将状态记录为 `failed`。

## 6. 向导行为

向导包含三个步骤：

1. **检查与确认**：说明升级目的、备份和验证行为，展示脱敏统计。
2. **执行迁移**：显示执行状态；失败时提供重试、脱敏诊断导出和退出入口。
3. **完成与备份**：显示备份位置。刚完成迁移的当前会话可以进入 DBX，也可以在确认连接正常后删除备份。

重启行为有明确区分：

- 迁移刚完成的当前会话显示完成页。
- 之后再次启动，如果状态为 `succeeded` 或 `not_required`，直接进入主界面。
- 保留备份不会再次阻塞启动。

向导右上角可以临时切换语言。迁移文案覆盖当前支持的语言，未单独覆盖的字段仍通过项目的英文回退机制解析。

## 7. 跨平台同步

跨平台同步不复制 Windows DPAPI、macOS Keychain、Linux Secret Service 或本地 DEK。

Windows 到 Mac 的流程是：

1. 源设备读取本地 Secret Store 中的明文值。
2. 公开配置与敏感 payload 分离。
3. 用户输入同步口令，通过 Argon2id 派生同步密钥。
4. 使用 AES-256-GCM 加密敏感 payload。
5. 目标设备输入相同同步口令并解密。
6. 目标设备使用自己的本地 Secret Store 重新加密保存。

导入支持只导入元数据或同时恢复 secrets。错误同步口令、ID 冲突和任一字段失败时，不提交半成品数据。

## 8. 兼容与回滚

- 新用户只执行轻量扫描，不创建迁移备份。
- 旧数据库和旧 JSON 可以直接升级，不要求用户先安装中间版本。
- 旧同步包继续按版本兼容规则读取；新同步包使用独立的 crypto version。
- 迁移失败保留原数据库和迁移备份，可以反复重试。
- 迁移成功后备份默认保留，用户确认连接正常后才清理。
- 直接复制 `dbx.db` 不属于受支持的跨平台迁移方式。

## 9. 用户排障

### 向导重复出现

确认使用的是包含迁移状态缓存修复的版本。向导成功后重启应直接进入主界面；如果仍显示向导，导出脱敏诊断，重点查看：

- `state`
- `needsMigration`
- `errorCode`
- `backupPath`
- `counts`

如果 `state` 为 `succeeded` 但统计仍显示旧数据，通常是旧版本扫描缓存，升级后的版本会自动重新扫描。

### 密钥不可用

- 桌面端：允许 DBX 访问系统钥匙串/凭据存储。
- Web/Docker：确认 `${DBX_DATA_DIR}/.dbx/secret.key` 与数据卷一起保留，或显式配置的 `DBX_SECRET_KEY_FILE` 可读。
- 不要删除或更换已经用于加密数据库的密钥文件。

### 迁移失败

原始数据不会被直接删除。修复向导提示的问题后点击 **重试迁移**。如果需要提交问题报告，只导出向导提供的脱敏诊断，不要上传 `dbx.db`、WAL 文件或迁移备份目录。

## 10. 实现位置

| 模块 | 主要职责 |
| --- | --- |
| `crates/dbx-core/src/persistence/secret_codec.rs` | 本地密文、密钥提供者和密钥材料解析 |
| `crates/dbx-core/src/persistence/storage.rs` | 迁移状态、预检查、备份、迁移和验证 |
| `crates/dbx-core/src/persistence/cloud_sync.rs` | 跨设备同步 payload 和导入导出事务 |
| `src-tauri/src/migration_gate.rs` | 桌面端业务 API 启动门禁 |
| `crates/dbx-web/src/routes/migration.rs` | Web/Docker 迁移 API |
| `crates/dbx-web/src/main.rs` | Web 端迁移门禁 |
| `apps/desktop/src/StartupGate.vue` | 桌面端启动路由和向导阻塞 |
| `apps/desktop/src/components/migration/SecurityMigrationWizard.vue` | 向导 UI、语言切换和诊断导出 |
| `apps/desktop/src/stores/migrationStore.ts` | 向导状态和动作编排 |

## 11. 测试与验收

### 自动化测试

迁移相关前端测试覆盖：

- 成功迁移后的启动行为。
- 迁移失败和重试。
- 状态检查失败。
- 备份清理失败和重试。
- 诊断导出失败时的页面内报告。
- 多语言资源和回退。

推荐命令：

```bash
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec vitest run apps/desktop/src/stores/migrationStore.spec.ts apps/desktop/src/components/migration/SecurityMigrationWizard.spec.ts
git diff --check
```

Rust 侧应覆盖密文 AAD、迁移缓存失效、数据库事务回滚、JSON 改名顺序、备份清理安全校验和 Web/Tauri 启动门禁。

### 手工冒烟

至少验证以下环境：

1. macOS、Windows、Linux 桌面端各完成一次旧数据迁移。
2. Docker 命名卷与直接运行 `dbx-web` 都能保留数据目录密钥，重启后仍可读取密文。
3. 迁移成功后关闭并重新打开，直接进入主界面。
4. 错误密钥、错误同步口令和损坏 JSON 不会破坏原始数据。
5. Windows 导出、Mac 导入后，连接和插件 secret 可以正常使用。

## 12. 维护约定

迁移向导 UI 可以在后续版本弱化，但 `secret-store-v1` 引擎、旧 schema 识别、旧密文读取、旧同步包兼容和失败恢复能力必须长期保留。用户可能从很旧的版本直接升级，不能依赖连续升级路径。

# 全方位代码评审报告（2026-09-30）

- 分支：`review/comprehensive-20260930`（自 `main` @ `2da17e558` 新建）
- 评审对象：工作区未提交改动（7 文件，+495/−92）+ 项目级安全/质量扫描
- 评审方式：四条独立车道并行（代码质量评审、安全审计、架构评审、全仓库高危模式扫描），各自在干净上下文独立取证后合成
- 验证证据：`vitest run PluginWorkbenchHost.spec.ts` 7/7 通过；`cargo test --lib commands::plugin_file` 14/14 通过；`cargo clippy` 仅 2 条测试代码警告

## 结论

| 车道 | 结论 |
|---|---|
| 代码质量车道 | REQUEST CHANGES |
| 架构车道 | **WATCH** |
| **最终结论** | **REQUEST CHANGES** |

本次改动（插件拖放文件访问：单文件 eager 打开 → 文件夹整体授权 + 惰性按需读取，`plugin_file_open` 更名 `plugin_file_open_dropped`）方向正确、质量较高：安全门完整保留（授权按 webview 注册/一次性消耗、symlink 遍历排除、文件数 2000/深度 8 上限、跨插件不可区分拒绝、写仍仅限保存对话框），双轨桥接（tauri.ts/http.ts）对称，测试钉住行为。**无 CRITICAL/HIGH（diff 层面）**；但有 5 项 MEDIUM 建议合入前处理（修复成本都很小），另有项目级结构性风险见文末。

---

## 一、改动评审（diff）— MEDIUM（建议合入前处理）

### M1 · 惰性读取 TOCTOU：授权钉的是路径字符串而不是文件内容
- 位置：`src-tauri/src/commands/plugin_file.rs:294-325`（每次 chunk 读取 `File::open` 按路径重开）、`:513`（symlink 仅遍历时排除一次）
- CWE-367 / CWE-59。相对旧 eager 实现（open 即持 fd）是**实质性回退**：注册与读取之间，被授权路径可被同机其他进程替换为 symlink（如指向 `~/.ssh/id_rsa`），插件读到任意文件，宿主无感知。需本地攻击者配合，但同步盘/SMB 目录下场景现实。
- 修复：注册时记录 `(dev, ino)`，读取 open 后 `fstat` 比对，不匹配即拒绝 `"file changed since the drop was granted"`；注册期入口（`:427`）改用 `symlink_metadata` 判 dir/file。

### M2 · `plugin_file_open_dropped` 返回裸 `Vec`，截断对插件与用户不可见
- 位置：`plugin_file.rs:385`（本模块其余命令均为 `Result<_, String>`）、`:430-433`（文件数截断仅 host 日志 warn）、`:500-503`（深度截断静默丢弃，连日志都没有）
- 用户拖 5000 文件、插件只拿 2000，且不知道丢了。wire contract 一旦有插件按"静默截断"写死，事后补字段就是兼容性迁移——现在改是一小时的事，之后是契约迁移。
- 修复：返回 `Result<Vec<PluginFileHandle>, String>`，payload 增 `truncated: bool`（`#[serde(default, skip_serializing_if = "std::ops::Not::not")]` 保持兼容）；深度截断补 `log::warn`；`plugin_id` 为空（`:412-414`）改返回错误，勿与"未授权"混同。

### M3 · `dropped_files` 元数据注册表无总量上限
- 位置：`plugin_file.rs:71-82, 457-484`；`pluginHostBridge.ts:533-535`（单条 postMessage 无大小上限）
- CWE-770。旧 eager 路径受 `MAX_OPEN_HANDLES=64` 硬约束；新 lazy 路径每次拖放最多注册 2000 条且无总量机制，混拖 N 个文件夹 = 2000×N。插件不 close、长会话反复拖放大目录 → 内存无界增长。
- 修复：`dropped_files` 加全局上限（如 10000）+ 注册时间戳（超限拒绝或 LRU 淘汰）；`forwardFileDrop` 按 MAX_BRIDGE_PAYLOAD_BYTES 分片/截断并告警。

### M4 · `close_plugin_file` 以错误字符串匹配做控制流分派
- 位置：`plugin_file.rs:363-381` 与 `:196-204` 的 `"unknown plugin file handle"` 魔法耦合
- 该字符串同时是对插件的 wire 契约、有被改动动机；一旦文案变化，fallback 静默失效——dropped 条目永远无法 close、注册表泄漏且无报错。前端还先 `openTauriHandles.delete` 再 `await close`（`PluginWorkbenchHost.vue:262-264`），失败无重试。
- 修复：内部路由改显式信号（`enum Lookup { Found, Missing, Foreign }` 或 `Result<Option<()>, String>`，`None` = 未命中 eager 注册表），展示字符串不当协议用。

### M5 · 同步 Tauri 命令中执行文件夹遍历，可能冻结主线程
- 位置：`plugin_file.rs:384-392, 492-538`（`pub fn`，同文件 dialog 命令 `:544/:582` 均为 `async fn`）
- 最多 2000 次 stat + read_dir 深度 8 遍历，在 NAS/网络盘上可阻塞 UI 数秒。
- 修复：改 `async fn` + `tauri::async_runtime::spawn_blocking`（模式现成，一行改动级别）。

### M6 · 需一次运行时验证的架构前提（SEC-106，非本 diff 引入）
- 位置：`src-tauri/src/lib.rs:1832`、`src-tauri/capabilities/default.json`
- 整座权限桥建立在"插件 iframe（`sandbox="allow-scripts"`，opaque origin）触达不了 Tauri IPC"之上；Tauri v2 初始化脚本通常注入所有 frame，若 `__TAURI_INTERNALS__` 在沙箱 iframe 内存在，恶意插件可绕过全部同意门直接 invoke。本快照 wry 为 vendored 无法静态确认。
- 行动：在插件 iframe 控制台执行 `typeof window.__TAURI_INTERNALS__` 验证；若可触达，插件 UI 迁独立子 webview 并用 capability 排除自定义命令。

## 二、改动评审（diff）— LOW（可作后续跟进）

1. `plugin_file.rs:427-444` 文件夹整体授权不过滤 dotfiles：拖代码仓库会把 `.git`/`.env`/密钥一并交给插件且 `.git/objects` 轻松吃掉 2000 上限。建议跳过 `.git`/`.DS_Store` 或宿主层弹一次"将共享 N 个文件"确认（SEC-103，授权粒度产品决定）。
2. `plugin_file.rs:90-97` + `lib.rs:1801-1805`：drop grant 永久有效，`WindowEvent::Destroyed` 不按 label 清理；建议清理 + grant TTL（如 60s）（SEC-104 / CWE-459）。
3. `plugin_file.rs:423,432,441` + `PluginWorkbenchHost.vue:366`：日志/console.error 记录拖放绝对路径，建议脱敏为 basename 或哈希（SEC-105 / CWE-532）。
4. `PluginWorkbenchHost.vue:365-366`：拖放空结果仅 `console.error`，用户无 toast、插件收不到任何事件，建议 forward 空 `filedrop` 或弹 toast 二选一闭环。
5. `PluginWorkbenchHost.vue:128-139 + 298-306`：卸载与 invoke 返回的窄窗口竞态可泄漏注册表条目，add 前检查 `disposed` 即可。
6. `plugin_file.rs:463`：每文件 3 次 stat，walk 携带 `(path, size)` 可省一次系统调用并消除 walk/register 间元数据不一致。
7. `plugin_file.rs:487`：文档"symlinks never followed"仅对文件夹内部成立，顶层 symlink→目录会被跟随展开，措辞需精确。
8. `plugin_file.rs:419-425`：`paths` 数组无长度上限，可刷日志；建议入口限 ≤256。
9. `pluginHostBridge.ts:438-455`：capability 握手未通告文件夹展开能力，按桥自身"absence means unsupported"惯例应补 `droppedFolderExpansion: true` 之类字段。
10. `plugin_file.rs:838,843`：测试代码 2 条 clippy 警告（`useless_format`、slice 后 `as_bytes`），顺手清零。
11. `plugin_file.rs` 已 960 行（两个注册表 + 三条 consent 流 + 遍历器），下次触碰时拆 `plugin_file/`（drop/dialog/registry）。

## 三、项目级扫描（不限于本次改动）

### HIGH（结构性，建议尽快单独开任务）
- `src-tauri/tauri.conf.json:45-47`：`"csp": null`，WebView CSP 完全关闭。全仓 55 处 `v-html` 依赖各处**手工维护**的 marked 自定义转义 renderer（约定式安全），任何一处新增 renderer 漏转义即直接可利用，CSP 是最后的兜底防线。
- `src-tauri/capabilities/default.json`：`fs:allow-write-file`/`fs:allow-read-file`/`fs:allow-read`/`fs:allow-open`/`fs:allow-stat` 未限定路径 scope（仅 `fs:allow-read-text-file` 限到 `$HOME/.dbx/*`）→ 任意前端 XSS 可升级为任意文件读写。
- 两者叠加构成最突出的纵深防御缺口。修复：启用最小化 CSP + fs 权限加路径 scope。

### MEDIUM
- `crates/dbx-core/src/data/data_compare.rs:1117/1161` 等数据对比/预览 SQL 构建器 `format!` 拼接标识符未加引号，恶意库可借对象名实现二阶注入（导出路径已有 `quote_export_sql_string`，可复用）。
- `crates/dbx-drivers/src/db/sqlite.rs:535-537`：按连接 `url_params` 加载任意原生 SQLite 扩展（`unsafe LoadExtensionGuard`），属"配置即任意原生代码执行"面。
- 9 处 `danger_accept_invalid_certs(true)`（AI/Consul/Pulsar/Nacos/Meilisearch/rqlite/turso/MCP，均为用户显式开关）+ Kafka `TrustAllManager`：设计如此，建议在 UI 上持续明示风险状态。
- 供应链：核心 DB 驱动来自第三方 git fork（pinned rev）+ 大量目录级 vendored（wry、tiberius、rumqttc 等），审计面与升级滞后风险高。
- Tauri 命令暴露面 860 个 `#[tauri::command]`，人工审计负担大（未发现任意命令执行类命令，路径类命令有校验）。

### 干净项（已核验）
- 无硬编码密钥（命中均为测试 fixture/占位符；deploy 本地 compose 默认密码 `123456` 仅限本地开发配方，LOW）。
- 前端 markdown/高亮 sink 全部走转义 renderer，链接白名单显式拒绝协议相对路径（防 UNC/NTLM 泄漏）；生产代码无 `eval`/`new Function`。
- MCP HTTP 有同源鉴权 origin 白名单，非 CORS 全开；更新器签名校验完整；插件 zip 安装有 `enclosed_name()` 防 Zip Slip；`process::Command` 54 处均为数组传参无 shell 拼接；Rust `unsafe` 基本限于 OS 互操作（Win32/macOS），命令路径 unwrap 滥用少（`ssh_prompt.rs` 集中 10 处）。

## 四、合入建议

**REQUEST CHANGES**（architect 状态 WATCH，不阻止 merge-ready，但 M1/M2 建议合入前一起改）：

合入前处理（成本小、都在安全敏感路径上）：M1（dev/ino 钉身份）、M2（truncated 契约）、M3（注册表总量上限）、M4（close 路由去字符串匹配）、M5（命令异步化）。

合入后尽快：SEC-106 运行时验证、项目级 CSP + fs scope 两项 HIGH、data_compare 标识符引用、dotfiles 过滤决策。

其余 LOW 项按迭代跟进。

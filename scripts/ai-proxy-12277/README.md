# Issue #12277：通过 aliyun 复现本地 AI 请求误走代理

2026-10-16 在 Windows 上直接调用
`dbx_ai_provider::ai::build_ai_http_client()` 完成修复前复现和修复后验证。
客户端构建显式启用 `reqwest/system-proxy`，固定 reqwest 0.12.28、hyper-util 0.1.20。
其他依赖由本目录独立的 Cargo.lock 固定，不修改主工作区依赖。

## 拓扑和生命周期

- `ssh aliyun` 在服务器内存中执行 `remote_mock.py`，不上传文件、不安装软件。
- 模型 mock 和返回 502 的代理 mock 均绑定服务器 `127.0.0.1` 随机端口。
- SSH 转发到 Windows `127.0.0.1` 和 `[::1]`，客户端请求地址仍是 loopback。
- 每个请求启动独立客户端进程，只向该进程传入代理环境变量。
- 每例同时记录 HTTP 状态、TCP peer、服务器命中角色/方法/路径。
- SSH stdin 关闭时 mock 退出；驱动程序在 finally 中关闭隧道和远端会话。

## 运行

在仓库根目录用 PowerShell 7 执行（需要可用的 Windows Rust 编译工具链）：

```powershell
cargo build --offline --locked --manifest-path scripts\ai-proxy-12277\Cargo.toml --target-dir target\ai-proxy-12277
python scripts\ai-proxy-12277\run_proof.py
python scripts\ai-proxy-12277\run_proof.py --suite remaining
```

默认 `--expect fixed` 验证修复后的行为；在修复前代码上运行时，使用
`--expect baseline` 验证旧缺陷。两个套件分别是 13 例环境变量场景和 49 例补充场景。
新报告分别写入 `{fixed|baseline}-{environment|remaining}-results.json`，
不会覆盖下面列出的首轮历史报告。

本机 GNU 工具链需要额外的链接环境。本次构建前使用了仓库已有的
`target\sqlserver-7542-tools\rust-env.ps1`，这不是运行客户端所需条件。

## 修复前实际结果（历史证据）

运行时间、随机端口和逐例原始证据见
`target/ai-proxy-12277/proof-results.json`。

| 场景 | 状态 | 服务端实际命中 |
| --- | --- | --- |
| 清空进程代理环境变量，AI 代理关闭 | 200 | 模型 1，代理 0 |
| 设置 HTTP_PROXY 等，AI 代理关闭，IPv4 | 502 | 模型 0，代理 1 |
| 同上，开启 AI 显式代理但 loopback 跳过该配置 | 502 | 模型 0，代理 1 |
| 增加准确 NO_PROXY=127.0.0.1,localhost,::1 | 200 | 模型 1，代理 0 |
| NO_PROXY=127.* | 502 | 模型 0，代理 1 |
| NO_PROXY=127.0.0.0/8 | 200 | 模型 1，代理 0 |
| 设置代理环境变量，目标 localhost | 502 | 模型 0，代理 1 |
| 设置代理环境变量，目标 [::1] | 502 | 模型 0，代理 1 |
| IPv6 增加 NO_PROXY=::1 | 200 | 模型 1，代理 0 |
| 设置代理环境变量，POST stream=true | 502 | 模型 0，代理 1 |
| 同上，增加准确 NO_PROXY | 200 | 模型 1，代理 0，收到 SSE 数据 |
| 对照：reqwest builder.no_proxy()，保留代理环境变量 | 200 | 模型 1，代理 0 |
| 对照：公网域名配置显式代理 | 502 | 模型 0，代理 1 |

驱动程序退出码 0；13 个场景均符合预期。
其中预期 502 表示成功复现缺陷或验证可控代理路由，并不表示修复通过。

## 系统代理与完整 AI 入口补充验证（修复前）

`--suite remaining` 使用 Windows `RegOverridePredefKey` 将**当前测试进程**的
HKCU 映射到独立的临时易失性注册表键。底层 hyper-util 仍真实读取
`Software\Microsoft\Windows\CurrentVersion\Internet Settings` 中的
`ProxyEnable`、`ProxyServer` 和 `ProxyOverride`。其他进程读取原始注册表，
测试前后快照检查本机真实代理配置未改变。
API 的进程隔离与恢复语义见 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regoverridepredefkey)。

补充矩阵覆盖：

- 清空代理环境变量，仅使用 Windows 系统代理；禁用系统代理作对照。
- ProxyOverride 无绕过规则、`127.*`、准确地址、CIDR 和 localhost。
- IPv4/IPv6，流式/非流式，NO_PROXY 与系统绕过规则组合。
- 使用两个独立代理 mock 区分系统代理、环境代理和显式代理的优先级。
- DBX 完整 `list_models_core`、`test_connection_core`、`complete`、`stream` 入口；
  每个入口验证系统代理 IPv4/IPv6 失败和直连成功、环境代理失败和直连成功。
- 成功的流式入口检查解析后的文字为 `ok`，且有 done chunk；非流式检查结果为 `ok`。

原始证据在 `target/ai-proxy-12277/remaining-results.json`，执行日志在
`target/ai-proxy-12277/remaining-run.log`。

补充矩阵实际运行 **49 例（25 例路由组合 + 24 例完整 AI 入口）**，
49 例均符合预期，驱动退出码 0。加上首轮 13 例，共记录 62 个场景。
此处“符合预期”包含成功复现缺陷，并不表示生产代码已修复。

| 补充验证 | 实际观察 |
| --- | --- |
| 环境变量为空，系统代理启用，ProxyOverride=127.* | 502，模型 0 次、系统代理 1 次 |
| 系统绕过规则为准确 IPv4、IPv6 或 IPv4 CIDR | 200，直达模型 |
| localhost 在系统绕过列表中 | 200；移除绕过后 502 |
| 系统代理关闭 | IPv4 和 IPv6 均直连 200 |
| 环境 NO_PROXY 准确匹配，保留系统代理 | IPv4 和 IPv6 均直连 200 |
| IPv4 配置显式代理，系统绕过准确匹配 | 显式代理被跳过，模型 200 |
| IPv6 配置显式代理，即使系统绕过准确匹配 | 仍命中显式代理，502 |
| 公网目标同时配置系统代理和显式代理 | 命中显式代理；没有显式代理时命中系统代理 |
| 同时配置环境代理和系统代理 | 命中环境代理 |
| 四个完整 AI 入口，系统代理无有效绕过或环境代理无 NO_PROXY | 均失败，命中代理，模型未命中 |
| 四个完整 AI 入口，准确系统绕过或准确 NO_PROXY | 均成功，返回模型列表、连接成功、聊天文字和完成事件 |

清理检查：三个远端随机端口均拒绝连接；`HKCU\Software` 下
`DBXIssue12277-*` 临时键剩余 0 个；真实系统代理配置前后快照一致。

## 修复前结论

修复前实现只跳过添加显式代理，没有在本地目标场景关闭自动代理发现。
AI 代理关闭不阻止本次请求采用环境变量代理；TCP peer 和远端命中记录共同证明了路由。
准确 NO_PROXY 和 no_proxy() 对照证明模型及 SSH 转发正常。

第一轮 13 例仅验证环境变量代理；补充矩阵验证 Windows 系统代理注册表读取路径。
本机实际 ProxyEnable 原始值为 0，没有更改真实 Internet Settings 或 Clash 配置。
只在专用命名空间创建临时注册表键，并在各测试进程退出前恢复映射、删除临时键。

另确认 IPv6 回环识别缺口：`reqwest::Url::host_str()` 对 IPv6 返回 `[::1]`，
原先的 `host.parse::<IpAddr>()` 不接受方括号，因此本地 IPv6 地址没有跳过显式代理。
即使系统 ProxyOverride 准确包含 `::1`，显式代理仍收到这类请求；
相同配置的 IPv4 请求会直连。原始结果同时记录 url_host 和实际命中代理角色。

模型列表入口先解码 JSON；遇到代理返回纯文本 502 时，错误可能表现为 JSON 解码失败，
而不是带 502 的错误文字。用服务端命中记录确认路由，避免仅按错误字符串判定。

## 修复内容与验收

- 解析 IPv6 主机时先去除配对方括号，再判断 IP 是否为回环地址。
- 回环目标在实际客户端构造时调用 `no_proxy()`，同时禁用环境、系统和显式代理。
- 非回环目标保留原有代理逻辑；未增加 DNS 查询或私网地址自动绕过。
- 永久回归测试使用独立子进程和本地模型/代理 mock；测试依赖显式启用 system-proxy。
  检查响应状态、TCP peer、模型与代理命中次数。旧代码四组回环测试失败、公网对照通过。

修复后验收证据：

- `target/ai-proxy-12277/provider-tests-green.log`：provider 完整测试。
- `target/ai-proxy-12277/fixed-environment-results.json`：13 例环境变量场景。
- `target/ai-proxy-12277/fixed-remaining-results.json`：49 例系统代理及完整 AI 入口场景。
- `target/ai-proxy-12277/regression-red.log`：修复前回归失败记录。

修复后预期：全部回环请求直达模型，普通请求返回 200；四个完整 AI 入口返回正确数据。
公网代理对照仍返回 mock 的 502，并命中预期代理，这表示公网代理路由得到保留。
原有 `environment-over-system-priority` 场景的目标也是回环地址，修复后应直连，
不再用它断言环境代理优先级；公网环境/显式代理优先级由永久回归测试验证。

修复后实际运行结果：266 个单元测试和 5 组真实请求回归测试通过。
保留 4 个原有忽略测试；额外 1 个忽略项是由父测试显式启动的子进程入口。
阿里云两轮验收 **13/13 + 49/49 全部通过**，旧复现结果保持原样。
全部本地请求命中模型而非代理，四个完整 AI 入口均成功，公网代理对照保留原行为。
独立代码审查未发现正确性问题。

`target/ai-proxy-12277/fixed-cleanup-verification.json` 记录清理验收：
真实代理配置前后一致、临时注册表键为 0，远端 mock 和本地隧道端口均已关闭。

第一轮流式场景仅调用真实构造器；补充矩阵调用完整聊天流解析入口。
上述 62 例没有操作真实 Clash/TUN；后续真实 FlClash 验证见下节。

## 保持联网配置原样的真实 FlClash 验证

本机运行 FlClash.exe（PID 11604）和 FlClashCore.exe（PID 4756），
核心实际监听 `127.0.0.1:10433`。测试时真实 Windows `ProxyEnable=0`，
测试终端的 HTTP_PROXY/HTTPS_PROXY 指向该端口，NO_PROXY 原始值包含回环地址。

```powershell
python scripts\ai-proxy-12277\run_proof.py --suite real-clash --real-proxy http://127.0.0.1:10433
```

本次 30 例全部通过：

- 1 例强制经过真实代理的 reqwest 对照：TCP peer 为 `127.0.0.1:10433`，
  FlClash 将请求转发到模型，返回 200。此对照未调用 DBX 构造器。
- 12 例 DBX 实际请求：IPv4、localhost、IPv6 分别覆盖继承原始环境、
  子进程代理指向真实 FlClash 且移除 NO_PROXY、显式代理、系统代理读取链路。
- 5 例补充组合：环境 NO_PROXY=127.*、系统无绕过规则的 IPv4/IPv6、
  两种 IP 的 stream=true 请求。
- 12 例完整 AI 入口：模型列表、连接测试、普通聊天和流式聊天，分别覆盖
  环境代理 IPv4、系统代理 IPv4、显式代理 IPv6，均返回正确内容。

修复后的普通请求 TCP peer 均是模型转发端口，而非真实 Clash 端口；
全部 DBX 请求均有且仅有一次模型命中。流式入口解析出 `ok` 和 done 事件。
系统代理场景只在测试进程中映射隔离注册表，启用后指向**真实 FlClash**，
未修改真实 Windows 代理开关。

测试没有退出/重启 FlClash，也没有切换节点、系统代理或 TUN。
前后快照确认 FlClash 进程及创建时间、10433 端口归属和真实代理配置一致。
远端服务、本地模型转发及临时注册表已清理。

证据：

- `target/ai-proxy-12277/fixed-real-clash-results.json`：30 例原始结果。
- `target/ai-proxy-12277/real-clash-state-before.json` 和 `real-clash-state-after.json`：状态快照。
- `target/ai-proxy-12277/real-clash-verification.json`：结果、配置一致性与清理验证。

边界：本机 FlClash 对强制代理对照返回 200，因此本轮未重现原反馈的 502；
验证的是修复后本地请求确实不经过实际运行的 Clash。
上述 30 例没有操作 DBX 桌面 GUI、真实模型、API Key 或数据库连接，也未验证 TUN 开关切换。

## Windows 桌面 GUI 验证（2026-10-17 至 2026-10-18）

使用包含修复的本地 Tauri 桌面构建，连接实际 Rust 后端和 Vite 开发前端，
数据目录与 WebView profile 均隔离到 `target/ai-proxy-12277/`。模型为本机 HTTP/SSE mock，
不使用真实 API Key；临时 SQLite 数据库仅提供 AI 助手要求的连接上下文。

- IPv4：`http://127.0.0.1:13937/v1`，关闭 AI 显式代理。
- IPv6：`http://[::1]:13938/v1`，启用 AI 显式代理并指向未监听的 `http://127.0.0.1:1`。
- 测试应用的 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 指向真实 FlClash `127.0.0.1:10433`，
  移除该子进程的 NO_PROXY；没有修改全局环境或 FlClash 配置。
- 两组均通过 GUI 模型发现、连接测试、配置保存和 Ask 流式聊天；聊天显示
  `DBX_GUI_12277_OK: local model responded successfully.`。
- 模型请求日志与应用进程 socket 采样共同确认直连 `127.0.0.1:13937` / `::1:13938`。
  应用后台更新检查也会连接代理，不能用整个应用是否出现 10433 连接判断 AI 请求路由。

构建命令为 `cargo build --offline -p dbx --no-default-features --features sqlite-bundled`。
该精简构建未启用 os-keyring，最初保存非空代理配置出现 KEY_PROVIDER_UNAVAILABLE；
为测试进程指定独立 DBX_SECRET_KEY_FILE 后保存成功，重启后 IPv6 配置与聊天验证通过。
另一次启动因缺少构建依赖的 DLL 搜索路径返回 0xC0000135，恢复构建环境 PATH 后正常启动。
这两项是测试构建环境处理，没有追加生产代码修改。

证据位于 `target/ai-proxy-12277/`：

- `gui-evidence/`：IPv4/IPv6 连接成功、模型列表、聊天回复截图及对应 UIA 文本。
- `gui-mock-requests.jsonl` 与 `gui-desktop-network.jsonl`：请求及实际 TCP 连接记录。
- `gui-verification.json`：结果汇总；`gui-cleanup.json`：清理检查。

测试应用、模型 mock、Vite 和监控进程已退出，1420/13937/13938 无残留监听，
真实 FlClash 10433 监听仍保留。跨日运行中不以 PID 恒定作为验收条件。
本轮没有切换系统代理、节点或 TUN，也没有使用真实模型；GUI 覆盖流式聊天，
非流式聊天仍由前述核心入口测试覆盖。

# DBX 插件开发快速开始

本文面向第一次开发 DBX 插件的开发者，覆盖 CLI 安装、项目创建、前后端模板选择、本地打包、签名、DBX 安装测试和发布前准备。

当前插件契约由以下部分组成：

- Manifest v1：描述插件身份、权限、入口和贡献点。
- Host API 1.x：沙箱前端与 DBX 宿主通信的接口。
- Sidecar Protocol v1：可选原生后端与 DBX 通信的协议。
- `.dbxp`：DBX 最终安装的插件包。

插件可以在 `manifest.json` 中声明可选的 `source`（源码仓库）和 `homepage`（项目主页）。这两个字段会随插件包签名并在“已安装”页面本地显示，因此不依赖联网；市场目录可以重复这些字段用于展示未安装插件。

正式文档和仓库提交流程参考 [`docs/content/docs/plugin-development.cn.mdx`](../docs/content/docs/plugin-development.cn.mdx)。完整协议和贡献点参考 [`README.md`](./README.md)，底层发布流程参考 [`RELEASING.md`](./RELEASING.md)。

## 先说结论：SDK 不需要“启动”

DBX 插件 SDK 不是一个常驻服务，不需要先启动 SDK Server。

开发时实际使用的是三类工具：

1. `dbx-plugin` CLI：创建项目、构建后端、打包和生成签名密钥。
2. Rust/Go SDK：仅供需要原生后端的插件链接使用。
3. DBX Host API：由 DBX 在插件沙箱页面中注入，前端通过 `window.dbxPlugin` 调用。

典型流程如下：

```text
插件源码
├── manifest.json
├── ui/
└── backend/（可选）
        │
        ▼
dbx-plugin package
        │
        ├── *.dbxp
        └── *.artifact.json
                │
                ▼
DBX 插件中心本地安装，或上传 Release 后进入插件商店
```

## 1. 安装 CLI

推荐直接安装预编译的 npm 包。安装过程不会编译 CLI，也不需要克隆 DBX 源码：

```bash
npm install --global @dbx-app/plugin-cli
dbx-plugin --help
```

也可以不做全局安装，直接运行：

```bash
npx @dbx-app/plugin-cli create my-plugin
```

npm 主包会自动安装 macOS、Linux 或 Windows 当前平台对应的预编译二进制，并携带匹配版本的 Rust/Go 插件 SDK。纯前端插件只需要 Node.js；只有插件自身包含 Rust 或 Go 后端时才需要对应语言的编译环境。

只有开发 CLI 本身或验证尚未发布的 SDK 改动时，才需要从 DBX 源码安装：

```bash
cd /path/to/dbx

CARGO_TARGET_DIR=/tmp/dbx-plugin-cli-target \
  cargo install --locked --path plugins/sdk/cli --force
```

CLI 在交互式终端中默认显示彩色输出。设置 `NO_COLOR=1` 可以关闭颜色。

## 2. 选择插件模板

`dbx-plugin create` 提供四种模板：

| 模板 | 组成 | 产物 | 适用场景 |
| --- | --- | --- | --- |
| `frontend` | 沙箱前端，无原生后端 | 一个 `universal.dbxp` | 纯 UI、信息面板、调用 Host API 的轻量工具 |
| `svelte` | Svelte + Vite 沙箱前端，无原生后端 | 一个 `universal.dbxp` | 使用 Svelte 编写的自定义工作台 |
| `rust` | 沙箱前端 + Rust Sidecar | 每个平台一个 `.dbxp` | SSH、终端、复杂协议、系统能力、高性能任务 |
| `go` | 沙箱前端 + Go Sidecar | 每个平台一个 `.dbxp` | 已有 Go 生态、网络服务、协议客户端 |

不需要后端时直接选 `frontend`。不要为了“像完整插件”而强行添加 Sidecar；只有浏览器沙箱无法完成的能力才需要 Rust 或 Go 后端。

## 3. 创建第一个前端插件

运行交互式向导：

```bash
dbx-plugin create ~/Desktop/dbx-plugin-demo --template frontend

# 使用 Svelte + Vite 工作台模板
dbx-plugin create ~/Desktop/dbx-plugin-svelte --template svelte
```

也可以一次性传入全部参数：

```bash
dbx-plugin create ~/Desktop/dbx-plugin-demo \
  --template frontend \
  --id com.example.dbx-plugin-demo \
  --name "DBX Plugin Demo" \
  --publisher example \
  --description "A small DBX frontend plugin." \
  --version 0.1.0 \
  --yes
```

生成的目录结构如下：

```text
dbx-plugin-demo/
├── .github/workflows/plugin-release.yml
├── assets/plugin.svg
├── ui/index.html
├── dbx-plugin.toml
├── manifest.json
└── README.md
```

其中：

- `manifest.json` 是 DBX 运行时读取的插件契约，声明名称、图标、权限、入口、国际化和贡献点。
- `dbx-plugin.toml` 是开发和打包配置，决定要包含哪些目录，以及是否需要构建原生后端。
- `ui/index.html` 是沙箱前端入口，可以换成构建后的 Vue、React、Svelte 或其他静态资源。
- `assets/plugin.svg` 是插件提供的图标；未提供可用图标时，DBX 才使用默认图标。

## 4. 修改前端和使用 Host API

生成的前端示例已经可以调用 DBX Host API：

```html
<script>
  await window.dbxPlugin.ready;

  const locale = window.dbxPlugin.locale;
  const context = await window.dbxPlugin.request("host.getContext");

  console.log(locale, context);
</script>
```

常用对象：

- `window.dbxPlugin.ready`：等待 DBX 完成宿主桥接初始化。
- `window.dbxPlugin.locale`：读取当前 DBX 界面语言。
- `window.dbxPlugin.context`：读取当前工作台允许访问的上下文。
- `window.dbxPlugin.request(...)`：调用宿主提供的方法。
- `window.dbxPlugin.invoke(...)`：调用插件自己的原生 Sidecar 方法。

插件前端运行在沙箱中，不能直接导入 DBX 内部 Vue 组件，也不能直接访问 Tauri、Node.js 或任意本地文件。需要的能力必须通过 Manifest 权限和 Host API 明确暴露。

### 国际化

国际化分为两层：

1. `manifest.json` 的 `localizations`：翻译插件名称、说明、连接字段、按钮和贡献点名称。
2. 插件自己的 UI：根据 `window.dbxPlugin.locale` 选择文案或接入自己的 i18n 库。

生成模板已经包含中文和英文切换示例，可以直接扩展其他语言。

## 5. 打包未签名开发包

### 打包前：使用独立浏览器开发环境

Agent 可通过只读接口获取调试日志，无需浏览器会话：

```bash
curl -sS 'http://127.0.0.1:5190/api/diagnostics?after=0&limit=100'
```

端口使用实际启动值。增量查询传入上次返回的 `nextAfter`（作为 `after`）与 `instanceId`，可增加 `level=error` 筛选错误。`hasMore` 表示还有下一页，`reset` 表示实例或游标重置，`truncated` 表示旧日志已被覆盖。日志沿用界面脱敏规则，仅保留内存中最近 500 条。详见 [Agent 调试接口](sdk/dev-host/README.md#agent-diagnostics-api)。

语言按钮支持中文与英文，同时切换调试外壳、日志面板和插件语言；插件名称与字段标签使用 Manifest 本地化。已有插件页面在确认后自动重载，取消则保持原语言。用户保存的连接名称与业务数据不翻译。

顶部“自动重载”默认关闭。启用后，UI 输出更新会自动刷新所有插件页面；Rust/Go 后端源码修改会自动构建并重启。编译型前端仍需配置 `ui_watch`。已保存连接配置不会丢失，但后端重启后需重新连接；页面草稿与进行中的操作可能丢失。构建失败不会启动旧产物，重启调试服务后此开关恢复关闭。

配置 `ui_watch` 后，监听命令必须在每次构建成功且产物全部写入后，向标准输出打印独立一行 `DBX_UI_BUILD_SUCCESS`，调试服务才会通知页面重载。请接入构建工具的成功回调，不要在失败或无条件退出回调中发送；仅修改输出文件不会触发重载。未配置 `ui_watch` 的静态页面仍按文件变化重载。

浏览器刷新或关闭后，旧页面的工作台会保留 30 秒，允许事件流短暂断开后重连；超时后回收工作台，并断开没有其他页面使用的连接。已保存的连接配置不受影响。

使用包含 `dev` 子命令的 CLI，可不启动 DBX 进行前后端联调：

```bash
dbx-plugin dev --path /path/to/my-plugin --port 5190
```

`--path` 默认为当前目录，端口占用时自动选择空闲端口。仅此子命令要求 Node.js 22+。纯前端插件直接打开工作台；Rust/Go 插件根据 `[backend]` 配置构建并启动后端，兼容 JSONL 和 framed v1。

可在 `dbx-plugin.toml` 配置前端构建命令：

```toml
[dev]
ui_build = ["npm", "run", "build"]
ui_watch = ["npm", "run", "build:watch"]
```

命令按参数数组执行，不经过 shell；未配置时使用已有 UI。先自行安装插件依赖，工具不会猜测框架或自动安装。前端重新构建后手动重载页面，后端改动后点击重建并重新连接。

点击“重载页面”右侧的“调试”，底部显示最近 500 条构建、后端状态、RPC 和请求校验日志，包含端口、项目与请求路径、耗时，以及可展开的 JSON 入参和出参。支持级别筛选、清空视图和自动滚动，终端同步输出 `[dbx-dev]` 日志。密码、令牌及 Manifest 声明的敏感字段脱敏，二进制内容省略，长内容截断；普通业务内容仍可见，仅用于本地开发。重启服务后历史清空。

开发环境提供声明式连接表单、工作台 Tab、RPC、事件、资源读取和主题切换。普通配置与凭据以本地明文形式保存在 `.dbx-dev/`，默认忽略提交，可通过 `--data-dir` 更换。它不读取 DBX 用户数据，也不替代真实宿主的安装、Secret Store 或生命周期验收。

源码构建和支持范围见[开发运行时说明](sdk/dev-host/README.md)。

### 构建安装包

进入插件目录并打包：

```bash
cd ~/Desktop/dbx-plugin-demo
dbx-plugin package .
```

前端插件默认生成：

```text
dist/
├── com.example.dbx-plugin-demo-0.1.0-universal.dbxp
└── com.example.dbx-plugin-demo-0.1.0-universal.artifact.json
```

- `.dbxp` 是交给 DBX 安装的文件。
- `.artifact.json` 包含目标平台、URL、SHA-256 和文件大小；签名构建还会写入 `signingKeyId`。
- 本地开发默认不签名。

未签名构建生成的元数据只适合本地检查，不能直接进入插件商店目录。商店条目必须包含 `signingKeyId`，安装前 DBX 会同时比对包内 Manifest 的 ID、版本、发布者、权限和签名 Key ID。

## 6. 在 DBX 中安装测试

未签名包只用于自己构建的本地开发测试：

1. 打开 DBX 顶部工具栏的“插件中心”。
2. 切换到“设置”。
3. 展开“第三方与开发者选项”。
4. 开启“允许安装未签名开发包”。
5. 点击“安装 `.dbxp`”，选择 `dist/` 中的文件。
6. 安装完成后切换到“已安装”，打开插件提供的工作台或其他入口。

本地开发包允许用相同版本重新安装，DBX 会替换当前开发版本并重启对应插件运行时；正式签名包仍不允许覆盖同版本。

测试结束后建议关闭“允许安装未签名开发包”。该开关只影响手动本地安装，不会放宽官方插件商店的签名校验。

## 7. 需要原生后端时

### Rust

```bash
dbx-plugin create ~/Desktop/dbx-rust-plugin \
  --template rust \
  --sdk-root /path/to/dbx

cd ~/Desktop/dbx-rust-plugin
dbx-plugin package .
```

### Go

```bash
dbx-plugin create ~/Desktop/dbx-go-plugin \
  --template go \
  --sdk-root /path/to/dbx

cd ~/Desktop/dbx-go-plugin
dbx-plugin package .
```

`--sdk-root` 让生成项目直接使用当前 DBX 工作区里的 SDK，适合 SDK 尚未发布或正在联调时使用。如果项目已经创建，也可以在打包前设置：

```bash
export DBX_PLUGIN_SDK_ROOT=/path/to/dbx
dbx-plugin package .
```

原生插件包含平台二进制，所以必须在对应平台构建：

- macOS Apple Silicon：`darwin-arm64`
- macOS Intel：`darwin-x64`
- Windows x64：`windows-x64`
- Linux x64：`linux-x64`
- Linux ARM64：`linux-arm64`

本机打包只产生当前平台的包。正式发布时由 GitHub Actions 矩阵在各个平台分别构建，开发者不需要手工准备所有电脑。

## 8. 候选包、仓库签名和 Key ID

### 本地开发可以不签名

`dbx-plugin package` 始终生成未签名候选包。自己开发测试时，在插件中心显式开启“允许安装未签名开发包”即可。这个开关只影响手动本地安装，不会放宽插件商店校验。

### 官方插件作者不管理签名密钥

官方发布流程只要求开发者提交源码、Release 和未签名候选包：

1. 开发者 CI 构建候选 `.dbxp` 和 `.artifact.json`。
2. DBX Store 审核源码、Manifest、权限、哈希和版本信息。
3. 受保护的 DBX Store 工作流使用官方仓库密钥签名审核通过的候选包。
4. 商店目录只引用最终签名包。

`publisher` 表示作者和商店归属，不表示签名密钥所有者。当前 v1 不要求开发者签名，也不做双签名。以后只有在商业分发或供应链证明确实需要时，才会新增独立的“作者证明”，不会改变现有仓库签名含义。

### Key ID 是什么

Key ID 是仓库签名公钥的稳定公开标识，不是密码，也不是私钥。自定义仓库可以使用：

```text
company.plugins.release
company.plugins.release:2026-01
company.repository-signing-v1
```

建议使用“仓库 + 用途 + 轮换版本”的命名方式。Key ID 最长 128 个字符，可使用字母、数字、点、横线、下划线和冒号。

同一个 Key ID 必须始终对应同一把 Ed25519 公钥。更换密钥时应创建新的 Key ID，而不是让旧 ID 指向另一把公钥。

### 自定义或私有仓库生成签名密钥

```bash
dbx-plugin keygen company.plugins.release
```

命令会：

- 创建 `.dbx-repository-signing-key.env`，Unix 下权限为 `0600`。
- 在终端打印 Key ID 和 Base64 公钥。
- 不在终端打印私钥。
- 如果文件已存在则拒绝覆盖，除非显式使用 `--force`。

仓库运营方在审核候选包后加载密钥并执行独立签名：

```bash
source .dbx-repository-signing-key.env
cargo run --release \
  --manifest-path /path/to/dbx/plugins/sdk/packager/Cargo.toml \
  -- sign candidate.dbxp signed.dbxp \
  --key-id "$DBX_PLUGIN_SIGNING_KEY_ID" \
  --artifact-metadata signed.artifact.json \
  --target universal
```

不要提交 `.dbx-repository-signing-key.env`。它包含仓库私钥，只能保存在密码管理器或受保护的仓库签名 CI Secret 中。官方插件开发者不需要执行本节。

### 在 DBX 中信任自定义仓库

使用自定义或私有仓库时，在插件中心“设置”的“自定义仓库信任”中填写：

- 仓库密钥 ID：`dbx-plugin keygen` 使用的 Key ID。
- Ed25519 公钥：`dbx-plugin keygen` 打印的 Base64 公钥。

官方插件商店的公钥由 DBX 管理，普通用户不需要手工添加。人工审核决定插件能否进入商店，仓库签名保证审核后的安装包没有被替换，两者不能互相替代。

## 9. 发布到 GitHub Release

生成项目已经包含 `.github/workflows/plugin-release.yml`。官方插件作者不需要配置任何签名 Secret 或 Key ID。

发布 GitHub Release 后，工作流会构建并上传：

- 前端插件：一个 `universal.dbxp` 候选包。
- Rust/Go 插件：各目标平台的 `.dbxp` 候选包。
- 每个候选包对应的 `.artifact.json`。
- 合并后的 `release-candidates.json`。

这些 `.dbxp` 不能直接作为官方商店安装地址。审核通过后，DBX Store 的受保护工作流生成最终签名包并发布到仓库控制的 Release/CDN。源码放在插件自己的 Git 仓库；`dbx-store` Git 仓库只保存商店元数据、最终下载地址、哈希、大小、仓库公钥和审核信息。

## 10. 常用命令

```bash
# 查看帮助
dbx-plugin --help
dbx-plugin create --help
dbx-plugin dev --help
dbx-plugin package --help
dbx-plugin keygen --help

# 创建纯前端插件
dbx-plugin create my-plugin --template frontend

# 创建 Svelte + Vite 插件
dbx-plugin create my-svelte-plugin --template svelte

# 创建 Rust 插件
dbx-plugin create my-plugin --template rust

# 创建 Go 插件
dbx-plugin create my-plugin --template go

# 仅在开发未发布的本地 SDK 时覆盖 SDK 根目录
dbx-plugin create my-plugin --template rust --sdk-root /path/to/dbx

# 打包当前项目
dbx-plugin package .

# 自定义/私有仓库运营方生成仓库密钥
dbx-plugin keygen company.plugins.release

# 关闭彩色输出
NO_COLOR=1 dbx-plugin --help
```

### 独立调试插件

无需启动 DBX，使用 Node.js 22+ 在浏览器中调试真实插件前后端：

```bash
# 在插件目录启动，默认端口 5190
dbx-plugin dev

# 指定插件目录和端口
dbx-plugin dev --path /path/to/my-plugin --port 5190

# 指定开发配置存储目录
dbx-plugin dev --path /path/to/my-plugin --data-dir /path/to/dev-data
```

启动后打开终端输出的本地地址，按 `Ctrl+C` 停止。端口占用时自动选择空闲端口。纯前端插件无需后端；Rust/Go 插件会根据项目配置构建并启动 Sidecar，需先安装对应工具链及插件依赖。

连接配置与凭据默认以明文保存在插件目录的 `.dbx-dev/` 中。前端构建监听通过 `[dev].ui_watch` 配置，自动重载默认关闭，可在页面中开启。完整配置与调试方式见[独立浏览器开发环境](#打包前使用独立浏览器开发环境)。

## 11. 常见问题

### `dbx-plugin: command not found`

确认 npm 全局命令目录已经加入 `PATH`，或者直接使用 `npx`：

```bash
npx @dbx-app/plugin-cli --help
```

### 我只想写前端，为什么还要安装 Rust？

不需要。`@dbx-app/plugin-cli` 安装的是 CI 预编译二进制；生成的 `frontend` 插件不包含 Rust 后端，最终 `.dbxp` 是跨平台的 `universal` 包。只有插件自身选择 Rust 后端，或者开发 CLI 源码时才需要 Rust。

### 为什么原生插件不能只构建一个包？

Rust/Go Sidecar 是操作系统原生二进制，不同系统和 CPU 架构不能混用。插件源码是一份，但 CI 会生成多个目标包；DBX 插件商店自动选择当前平台对应的包。

### `.dbxp` 会增加 DBX 主安装包体积吗？

不会。可选插件不打进 DBX 基础安装包。只有用户安装插件后，该插件才占用本机插件存储空间。

### 开发者提交源码还是 `.dbxp`？

两者都需要，但用途不同：源码保留在开发者仓库供审查和协作；开发者 CI 生成未签名候选 `.dbxp`；审核通过后由 DBX Store 发布最终签名 `.dbxp`；官方商店 Git 仓库只登记元数据和产物地址，不接收私钥，也不把大型二进制提交到 Git 历史。

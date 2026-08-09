# DBX 插件开发快速开始

本文面向第一次开发 DBX 插件的开发者，覆盖 CLI 安装、项目创建、前后端模板选择、本地打包、签名、DBX 安装测试和发布前准备。

当前插件契约由以下部分组成：

- Manifest v1：描述插件身份、权限、入口和贡献点。
- Host API 1.x：沙箱前端与 DBX 宿主通信的接口。
- Sidecar Protocol v1：可选原生后端与 DBX 通信的协议。
- `.dbxp`：DBX 最终安装的插件包。

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

`dbx-plugin create` 提供三种模板：

| 模板 | 组成 | 产物 | 适用场景 |
| --- | --- | --- | --- |
| `frontend` | 沙箱前端，无原生后端 | 一个 `universal.dbxp` | 纯 UI、信息面板、调用 Host API 的轻量工具 |
| `rust` | 沙箱前端 + Rust Sidecar | 每个平台一个 `.dbxp` | SSH、终端、复杂协议、系统能力、高性能任务 |
| `go` | 沙箱前端 + Go Sidecar | 每个平台一个 `.dbxp` | 已有 Go 生态、网络服务、协议客户端 |

不需要后端时直接选 `frontend`。不要为了“像完整插件”而强行添加 Sidecar；只有浏览器沙箱无法完成的能力才需要 Rust 或 Go 后端。

## 3. 创建第一个前端插件

运行交互式向导：

```bash
dbx-plugin create ~/Desktop/dbx-plugin-demo --template frontend
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
dbx-plugin package --help
dbx-plugin keygen --help

# 创建纯前端插件
dbx-plugin create my-plugin --template frontend

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

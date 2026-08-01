# DBX 本地开发环境、启动与调试指南

> 最近检查日期：2026-07-31  
> 检查环境：macOS 12.7.6 / Intel x86_64

本文档记录当前开发机器的环境检查结果，并整理 DBX 项目的首次准备、启动、调试和验证流程。环境版本会随时间变化，执行命令时仍应以仓库中的 `package.json`、`Cargo.toml`、CI 配置和实际命令输出为准。

## 1. 项目技术栈和目录

DBX 的主要技术栈：

- 桌面框架：Tauri 2
- 前端：Vue 3、TypeScript、Vite、Tailwind CSS
- 后端及数据库能力：Rust
- Node 包管理器：pnpm
- Web 后端：Axum

主要目录：

| 路径 | 用途 |
| --- | --- |
| `apps/desktop/src/` | Vue 桌面端和 Web 前端 |
| `src-tauri/` | Tauri 桌面壳层及命令层 |
| `crates/dbx-core/` | 通用 Rust 数据库逻辑 |
| `crates/dbx-web/` | Web HTTP 后端 |
| `packages/` | CLI、MCP Server 等 Node 包 |
| `agents/` | Java/JDBC Agent 驱动 |
| `scripts/` | 开发、发布及数据库环境脚本 |

## 2. 项目环境要求

仓库声明的主要要求：

- Node.js `>= 22.13.0`
- pnpm `10.27.0`
- Rust `>= 1.88`
- Make
- macOS 需要安装 Xcode Command Line Tools，不需要额外的 GTK/WebKit 包

CI 当前使用的主要版本：

- Node.js `22.13.0`
- pnpm `10.27.0`
- Rust `1.97.1`
- Rust 组件：`rustfmt`、`clippy`

## 3. 当前机器检查快照

| 项目 | 状态 | 检查结果 |
| --- | --- | --- |
| macOS | 满足 | macOS 12.7.6，Intel x86_64 |
| Xcode Command Line Tools | 满足 | Clang 14、macOS SDK 已安装 |
| Node.js | 满足 | `.nvmrc` 当前为 `22.14.0` |
| Codex CLI | 满足 | 已安装在 Node 22.14.0 下 |
| pnpm | 需要调整 | 全局安装为 10.17.1，项目要求 10.27.0 |
| Rust/Cargo | 缺失 | `rustc`、`cargo`、`rustup` 尚未安装 |
| Node 项目依赖 | 缺失 | 根目录 `node_modules` 尚不存在 |
| Tauri CLI | 待安装依赖 | 由项目 `devDependencies` 提供 |
| Make/Clang/Git | 满足 | 均已安装 |
| 磁盘空间 | 满足 | 可用空间约 163 GiB |
| 开发端口 | 满足 | 1420、1421、4224、5173 当前空闲 |
| Docker | 可选项未就绪 | CLI 已安装，但 Docker daemon 未启动 |
| JDK 21 | 可选项可用 | 已安装，但 jenv 当前选择 JDK 8 |

当前不能直接启动项目的主要原因：

1. Rust 工具链尚未安装。
2. pnpm 需要固定为项目要求的 10.27.0。
3. 项目 Node 依赖尚未安装。

## 4. 首次准备

### 4.1 进入项目并切换 Node

```bash
cd /Users/wzl/Documents/Code-workspace/dbx
nvm use
node --version
```

当前 `.nvmrc` 为 `22.14.0`，满足项目的 `>=22.13.0` 要求，并且这个 Node 版本下可以直接使用 Codex。

检查时 `.nvmrc` 从 `22.13.0` 改成 `22.14.0` 的修改已经进入 Git 暂存区。如果这只是本机开发的临时调整，不要误提交到不相关的提交中。

### 4.2 安装项目指定的 pnpm

NVM 会按 Node 版本隔离全局 npm 包，因此应在 `.nvmrc` 对应版本下安装 pnpm：

```bash
nvm use
npm install -g pnpm@10.27.0
pnpm --version
```

预期输出：

```text
10.27.0
```

如果以后把 `.nvmrc` 切回其他 Node 版本，需要在那个版本下重新安装 pnpm 和 Codex，或者使用其他独立于 NVM 的安装方式。

### 4.3 安装 Rust

安装 rustup：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

为了与当前 CI 一致，安装 Rust 1.97.1：

```bash
rustup toolchain install 1.97.1 \
  --component rustfmt \
  --component clippy

rustup override set 1.97.1
```

验证：

```bash
rustc --version
cargo --version
cargo fmt --version
cargo clippy --version
```

如果新终端中找不到 Cargo，确保 shell 启动配置加载了：

```bash
source "$HOME/.cargo/env"
```

### 4.4 安装项目依赖

```bash
pnpm install --frozen-lockfile
```

也可以使用项目封装的命令：

```bash
make install
```

首次安装和首次 Rust 编译需要访问 npm、crates.io 和 GitHub。Cargo 工作区中还包含若干 Git 依赖。

安装完成后验证：

```bash
pnpm tauri --version
pnpm check
make cargo-check-fast
```

## 5. 启动桌面端

### 5.1 推荐启动方式

开发版默认可能与已安装的 DBX 共用连接、历史数据和设置。为了避免调试代码影响真实数据，建议通过 `DBX_DATA_DIR` 使用隔离目录：

```bash
DBX_DATA_DIR=/tmp/dbx-desktop-dev \
RUST_BACKTRACE=1 \
make
```

`make` 等价于 `make dev`，主要流程为：

1. 在需要时安装 Node 依赖。
2. 启动 Vite 开发服务器，Tauri 模式端口为 `1420`。
3. 编译并启动 Tauri 桌面应用。
4. 前端修改通过 Vite HMR 热更新。
5. Rust 修改触发重新编译。

首次 Rust 构建会下载和编译大量依赖，耗时明显长于后续增量构建。

### 5.2 轻量特性启动

仓库提供：

```bash
make dev-fast
```

当前 Makefile 实际执行：

```bash
pnpm tauri dev -- --no-default-features --features duckdb-sidecar
```

因此 `make dev-fast` 仍然保留 DuckDB，只关闭 MQ、SQLCipher、系统字体等其他默认特性。README 中“跳过 DuckDB”的描述与当前 Makefile 不完全一致。

如果确实不需要调试 DuckDB，可以运行：

```bash
pnpm tauri dev -- --no-default-features
```

## 6. 启动 Web 版本

Web 模式需要分别启动 Rust 后端和 Vue 前端。

### 6.1 启动后端

终端一：

```bash
cd /Users/wzl/Documents/Code-workspace/dbx

DBX_DATA_DIR=/tmp/dbx-web-dev \
RUST_LOG=dbx_web=debug,tower_http=info \
RUST_BACKTRACE=1 \
make dev-backend
```

默认后端地址：

```text
http://localhost:4224
```

`scripts/dev-backend.mjs` 会自动检测 `cargo-watch`。如果没有安装，后端仍可启动，但 Rust 文件修改后不会自动重启。

可选安装：

```bash
cargo install cargo-watch
```

### 6.2 启动前端

终端二：

```bash
cd /Users/wzl/Documents/Code-workspace/dbx
make dev-web
```

浏览器访问：

```text
http://localhost:5173
```

Vite 会将 `/api` 请求代理到 `http://localhost:4224`。

Web 后端当前监听 `0.0.0.0:4224`。不要在不可信网络中使用 `DBX_DISABLE_PASSWORD=1`，以免把无密码开发服务暴露给局域网中的其他设备。

## 7. 调试方法

### 7.1 Vue 前端调试

前端问题优先使用 Web 模式调试：

```bash
make dev-web
```

浏览器开发者工具中可以：

- 在 Sources 中直接对 `.ts`、`.vue` 文件设置断点。
- 在 Network 中检查 `/api` 请求和 WebSocket。
- 在 Console 中查看前端日志和异常。
- 可选安装 Vue DevTools 查看组件、状态和事件。

Tauri 开发窗口中也可以使用 WebView 检查器。如果原生窗口中的检查器使用不便，可以先在 Web 模式复现和定位纯前端问题。

### 7.2 Tauri/Rust 日志

普通终端日志：

```bash
DBX_DATA_DIR=/tmp/dbx-desktop-dev \
RUST_BACKTRACE=full \
make
```

记录更完整的启动探针日志：

```bash
DBX_DATA_DIR=/tmp/dbx-desktop-dev \
DBX_STARTUP_LOG_DIR=/tmp/dbx-startup \
DBX_KEEP_STARTUP_LOG=1 \
RUST_BACKTRACE=full \
make
```

启动日志会写入：

```text
/tmp/dbx-startup/startup.log
```

DBX 设置中还提供“启用调试日志”选项。该选项默认关闭，排查问题时可临时打开。

### 7.3 Rust 断点调试

可以使用 VS Code CodeLLDB、CLion 或系统 LLDB。

通过 `make` 启动后，附加到对应进程：

- 桌面端：`dbx`
- Web 后端：`dbx-web`

如果要定位 panic，至少开启：

```bash
export RUST_BACKTRACE=1
```

需要完整调用栈时使用：

```bash
export RUST_BACKTRACE=full
```

### 7.4 Web 后端日志级别

```bash
RUST_LOG=dbx_web=debug,tower_http=debug make dev-backend
```

如果日志过多，可以降低 tower-http 的级别：

```bash
RUST_LOG=dbx_web=debug,tower_http=info make dev-backend
```

## 8. 测试和代码检查

### 8.1 前端综合检查

```bash
pnpm check
```

该命令并行执行：

- `oxfmt --check`
- `oxlint`
- `vue-tsc`
- `vitest run`

### 8.2 单独执行前端测试

```bash
pnpm vitest run path/to/file.spec.ts
```

### 8.3 Rust 快速检查

```bash
make cargo-check-fast
make cargo-test-fast
```

这两个命令使用 `--no-default-features`，适合日常快速验证。

### 8.4 Rust 格式和 Clippy

```bash
cargo fmt --check
cargo clippy --workspace --locked --all-targets --no-default-features -- -D warnings
```

### 8.5 前端构建验证

```bash
make build
```

该命令先运行 TypeScript 类型检查，再构建桌面前端。

## 9. 数据库测试环境

数据库实验室依赖 Docker。当前机器已安装 Docker CLI 和 Compose，但 Docker daemon 尚未运行。

使用前先启动 Docker Desktop，然后执行：

```bash
make db-list
make db DB=mysql@8.4
make db-verify DB=mysql@8.4
```

停止环境：

```bash
make db-down DB=mysql@8.4
```

重置会删除对应容器和数据，执行前确认目标：

```bash
make db-reset DB=mysql@8.4 CONFIRM=1
```

## 10. JDBC Agent 开发

只有开发 `agents/` 下的 Java/JDBC 驱动时才需要 JDK 21。

当前机器已安装 JDK 21.0.1，但 jenv 默认选择 JDK 8。进入 Agent 工程前切换：

```bash
jenv shell 21.0.1
java -version
javac -version

cd agents
./gradlew test
```

Gradle Wrapper 首次运行时可能下载 Gradle 和相关依赖。

## 11. NVM 切换后 Codex 找不到的原因

Codex 当前安装在：

```text
~/.nvm/versions/node/v22.14.0/bin/codex
```

NVM 会按 Node 版本隔离全局 npm 包。当 `.nvmrc` 切换到另一个 Node 版本时，新版本的 `bin` 目录会替换到 `PATH` 中，因此在旧版本下安装的 Codex 不再可见，并出现：

```text
zsh: command not found: codex
```

处理方法是在目标 Node 版本下重新安装：

```bash
nvm use
npm install -g @openai/codex pnpm@10.27.0
```

不要简单地把另一个 Node 版本的整个 `bin` 目录永久追加到 `PATH`，否则可能同时引入错误版本的 `node` 和 `npm`。

## 12. 日常开发推荐流程

开始开发：

```bash
cd /Users/wzl/Documents/Code-workspace/dbx
nvm use
pnpm --version
rustc --version
```

启动桌面端：

```bash
DBX_DATA_DIR=/tmp/dbx-desktop-dev RUST_BACKTRACE=1 make
```

提交前检查：

```bash
pnpm check
make cargo-check-fast
make cargo-test-fast
cargo fmt --check
```

如果修改了前端构建逻辑，再执行：

```bash
make build
```

如果修改了数据库适配逻辑，使用 Docker 数据库实验室或真实测试数据库补充验证。

## 13. 故障排查清单

启动失败时依次检查：

```bash
node --version
pnpm --version
rustc --version
cargo --version
pnpm tauri --version
```

检查端口：

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
lsof -nP -iTCP:4224 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

检查依赖：

```bash
test -f node_modules/.modules.yaml && echo "Node dependencies installed"
cargo metadata --no-deps
```

检查完整启动日志：

```bash
DBX_STARTUP_LOG_DIR=/tmp/dbx-startup \
DBX_KEEP_STARTUP_LOG=1 \
RUST_BACKTRACE=full \
make
```


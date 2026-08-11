# DBX 本地开发环境、启动与调试指南

本文档只记录仓库通用的准备和开发命令。版本与行为以仓库文件为准：

- Node.js：`.nvmrc`、`package.json#engines`
- pnpm：`package.json#packageManager`
- Rust：`Cargo.toml` 与 `.github/workflows/ci.yml`
- 开发入口：`Makefile` 和 `package.json#scripts`

## 1. 项目结构

| 路径 | 用途 |
| --- | --- |
| `apps/desktop/src/` | Vue、TypeScript、Vite 前端 |
| `apps/desktop/public/` | 前端静态资源 |
| `src-tauri/` | Tauri 桌面壳层 |
| `crates/` | Rust 工作区和数据库能力 |
| `packages/` | CLI、MCP Server 等 Node 包 |
| `agents/` | Java/JDBC Agent |
| `scripts/` | 开发、构建和发布脚本 |

## 2. 准备环境

### 2.1 macOS 工具链

安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

桌面端使用 Tauri 的系统 WebView。macOS 上的 WebView 版本由系统决定，升级系统或在目标系统上验证 UI 时，应同时检查亮色、暗色和主要弹窗。

### 2.2 Node.js 与 pnpm

```bash
nvm use
node --version
corepack enable
pnpm --version
```

当前仓库要求 Node.js `22.13.0` 及以上，包管理器版本以 `package.json#packageManager` 为准。若本机没有 NVM，请安装满足 `.nvmrc` 的 Node.js，再启用 Corepack 或安装仓库声明的 pnpm 版本。

### 2.3 Rust

安装 rustup，并按照 CI 配置的工具链准备 Rust：

```bash
rustup show
rustc --version
cargo --version
rustfmt --version
```

需要确认具体工具链时，查看 `.github/workflows/ci.yml` 中的 `dtolnay/rust-toolchain` 配置；不要依赖某台开发机的本地版本记录。

## 3. 安装依赖

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
```

或使用 Makefile：

```bash
make install
```

文档站点依赖单独安装：

```bash
make docs-install
```

## 4. 启动桌面端

标准 Tauri 开发模式：

```bash
make dev
```

轻量模式：

```bash
make dev-fast
```

如果希望隔离开发数据，可在启动前设置 `DBX_DATA_DIR`：

```bash
DBX_DATA_DIR=/tmp/dbx-desktop-dev \
RUST_BACKTRACE=1 \
make dev
```

Tauri 开发端口由 `Makefile` 的 `TAURI_DEV_PORT` 控制，默认是 `1420`。端口被占用时，可以使用其他端口并同步调整 Vite/Tauri 配置。

## 5. 启动 Web 版本

先启动 Rust Web 后端：

```bash
DBX_DATA_DIR=/tmp/dbx-web-dev \
RUST_LOG=dbx_web=debug,tower_http=info \
RUST_BACKTRACE=1 \
make dev-backend
```

再启动前端：

```bash
make dev-web
```

前端脚本和后端地址以 `apps/desktop/vite.config.ts`、`scripts/dev-backend.mjs` 及相关环境变量为准。

## 6. 常用检查

前端类型检查和构建：

```bash
pnpm typecheck
pnpm build
```

仓库检查与测试：

```bash
make check
make test
```

Rust 快速检查：

```bash
make cargo-check-fast
make cargo-test-fast
```

只运行前端 Vitest：

```bash
pnpm vitest run apps/desktop/src/components/ui/input/__tests__/Input.spec.ts
pnpm vitest run apps/desktop/src/styles/__tests__/legacyWebviewFallback.spec.ts
```

格式化和 lint：

```bash
pnpm fmt
pnpm lint
```

## 7. 数据库测试环境

查看可用环境：

```bash
make db-list
```

启动一个环境：

```bash
make db DB=mysql@8.4
```

验证、停止和重置：

```bash
make db-verify DB=mysql@8.4
make db-down DB=mysql@8.4
make db-reset DB=mysql@8.4 CONFIRM=1
```

这些命令依赖 Docker；具体数据库版本和 Compose 配置由 `scripts/` 与数据库环境文件维护。

## 8. 调试建议

- 修改 Vue、TypeScript 或 CSS 后优先使用 Vite HMR；跨平台问题再运行 Tauri 桌面模式。
- 前端启动失败时查看终端中的 `[STARTUP]` 日志，并保留完整错误堆栈。
- UI 兼容性问题应在目标 WebView 上复现，至少覆盖亮色、暗色、窄窗口和主要弹窗。
- 提交前运行相关 Vitest、`pnpm typecheck` 和 `git diff --check`。
- 提交前只保留可复现的仓库信息，临时环境值不要写入项目文档。

# 参与 DBX 贡献

感谢你愿意花时间了解 DBX。不管是改一个错别字、补文档，还是修某个数据库相关的问题，都很有价值。

## 从哪里开始

1. 浏览 [Issues](https://github.com/t8y2/dbx/issues)。优先看 `documentation`、`good first issue`，或者你手头正好有测试环境的数据库相关问题。
2. 在 Issue 下留言说明你想做什么，避免重复劳动。部分社区 Issue 也支持评论 `/claim` 来认领。
3. Fork 仓库，新建分支开发，然后向 `main` 提 PR。

如果暂时不确定做什么，文档和小体验修复很适合第一次贡献。可以先看 [examples/](examples/) 和[官方文档](https://dbxio.com/cn/docs/what-is-dbx) 熟悉项目结构。

## 开发环境

### 环境要求

- Node.js >= 22.13.0
- pnpm 10.27.0
- Rust >= 1.77
- Make

Linux 桌面端还需要 WebKit/GTK 相关依赖，具体命令见 [README.zh-CN.md](README.zh-CN.md#快速开始)。

### 本地运行

```bash
git clone https://github.com/t8y2/dbx.git
cd dbx
make
```

`make` 会在需要时安装依赖，并启动 Tauri 桌面端开发环境。

常用命令：

```bash
make dev-fast          # 本地开发跳过 DuckDB
make dev-web           # 只启动前端
make dev-backend       # 只启动 Web 后端
make docs              # 本地预览文档站
make cargo-check-fast  # 快速 Rust 检查
```

### JDBC Agent 驱动

Agent 驱动工程在 `agents/` 目录。Java/JDBC 驱动构建和测试需要 JDK 21；环境允许时 Gradle 可以自动下载对应 toolchain。

```bash
cd agents
./gradlew test
```

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/` | Vue 前端 |
| `src-tauri/` | Tauri 桌面端壳层与命令层 |
| `crates/dbx-core/` | 共享 Rust 数据库逻辑 |
| `crates/dbx-web/` | Docker / Web HTTP 后端 |
| `packages/cli/` | `@dbx-app/cli` |
| `packages/mcp-server/` | `@dbx-app/mcp-server` |
| `packages/node-core/` | Node.js bridge 与直连查询逻辑 |
| `docs/` | 官方文档站 |
| `examples/` | 配置与自动化示例 |
| `agents/` | JDBC Agent 驱动工程 |

## 开发约定

### 分支命名

分支名尽量简短明确，例如：

- `docs/web-api-reference`
- `fix/mysql-connection-timeout`
- `feat/redis-key-search`

### 控制改动范围

一个 PR 只做一类事。文档 PR 不要夹带无关代码；修 Bug 时也不要顺手大重构，除非重构是修复所必需的。

### 提交说明

提交信息用自然语言写清楚即可：

- `docs: add web API reference for Docker deployments`
- `fix(redis): handle empty scan cursor`
- `feat(schema): show catalog info for Doris`

### 测试

按改动范围跑对应检查：

```bash
make cargo-check-fast
make cargo-test-fast
pnpm test
```

如果改的是前端或某个 package，再补跑对应目录下的测试。

### 文档

用户文档主要分两块：

- 仓库内文档：`README.md`、`CONTRIBUTING.md`、各 package README、`examples/`
- 官网文档：`docs/content/docs/`

如果在 `docs/content/docs/` 新增页面，记得同步更新：

- `docs/content/docs/meta.json`
- `docs/content/docs/meta.cn.json`

本地预览：

```bash
make docs
```

## 提 PR

1. 把分支推到你自己的 Fork。
2. 向 `https://github.com/t8y2/dbx` 的 `main` 提 PR。
3. 在 PR 描述里关联相关 Issue。
4. 写清楚改了什么、怎么验证的；如果涉及 UI，附上截图。

改动越小，越容易 review 和合并。

## 欢迎的贡献类型

- 文档改进与翻译
- 可复现、行为清晰的 Bug 修复
- 你有真实测试环境的数据库专项修复
- 非平凡逻辑的测试补充
- CLI、MCP、Docker、Web API 的使用示例

## 社区

- [Discord](https://discord.gg/W7NyVDRt6a)
- [GitHub Issues](https://github.com/t8y2/dbx/issues)
- [官方文档](https://dbxio.com/cn/docs/what-is-dbx)

合并后的贡献者会出现在 [DBX 贡献墙](https://dbxio.com/cn/community)。

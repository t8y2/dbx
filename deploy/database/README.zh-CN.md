# DBX 数据库测试环境

此目录提供可重复创建的 Docker Compose 数据库环境，用于人工验证数据库功能。每个带版本的配方都固定镜像版本、使用命名卷、仅绑定本机回环地址、定义健康检查，并提供初始化数据或在验证阶段创建的冒烟数据。

在仓库根目录执行：

```bash
make db-list
make db DB=mysql@8.4
make db-verify DB=postgresql@17.4
make db-down DB=postgresql@17.4
```

每个产品都有专属的 `101xx` 至 `115xx` 默认宿主端口段，因此所有已提交配方可同时启动，且不会占用常见服务端口或在版本间冲突。默认密码统一为 `123456`，默认数据库名为 `dbx`；Redis 使用 DB 0 和 `dbx:` 键前缀。容器名统一为 `dbx-<product>-<version>`。`DB_PORT` 和 `DB_PASSWORD` 可覆盖主连接端口和密码；辅助端口使用各服务原有的专属环境变量覆盖。端口默认仅绑定 `127.0.0.1`；如需远程访问，必须显式设置 `DB_BIND_ADDRESS=0.0.0.0`，同时使用强密码和防火墙限制访问。`make db-reset` 会删除命名卷及其数据，因此必须显式传入 `CONFIRM=1`：

```bash
make db-reset DB=redis@7.4 CONFIRM=1
```

主要 Make 目标为 `db-list`、`db`、`db-verify`、`db-down`、`db-reset` 和 `db-check`。`make db-list` 会按产品归并展示各版本，并列出每项默认的容器到宿主机端口映射、镜像和支持平台。执行 `make db` 会为每个配方输出一条可直接复制的启动命令；对于 DBX 已支持的连接类型，启动完成后还会输出预填的 `dbx://connection/new` 链接，可在已安装 DBX 桌面端的 macOS 上通过 `open '<链接>'` 打开新建连接窗口。该链接可能包含密码，请不要将其写入共享终端历史、日志或工单。没有对应 DBX 连接类型的配方会显示深链不可用。`make db-completion` 会输出 Bash、Zsh 和 PowerShell 补全加载命令，`completion/` 中的脚本会动态补全配方选择器。目标不再依赖 POSIX Shell 条件语法，可在 PowerShell、Git Bash 或 WSL 中通过 GNU Make 使用。诊断时可使用底层命令 `pnpm db:env -- info|status|logs|shell <product> <version>`。

## 配方结构

```text
<product>/<version>/
├── recipe.json   # 连接字段和冒烟命令
├── compose.yaml  # Docker Compose 环境
└── init/         # 环境初始化数据
```

Redis 不支持镜像初始化目录约定；其 `init/README.md` 说明了 `verify` 会创建并读取的冒烟键。添加或修改配方后运行 `make db-check`。它会检查配方结构、标准容器名，并要求 Docker Compose 校验每个 Compose 文件。

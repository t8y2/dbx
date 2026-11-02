# DBX 公开演示环境

一键拉起一个可对外暴露的 DBX Web 演示栈：dbx-web（演示模式）+ PostgreSQL +
MySQL + Redis（均带示例数据）。访客打开 `http://<host>:4224` 即可免登录体验
完整的产品功能（连接预置的演示库、执行 SQL、网格编辑、导出等）。

## 快速开始

```bash
cd deploy/demo
docker compose up -d --build
```

定时重置（清空所有访客改动并重新播种）：

```bash
chmod +x reset.sh
# crontab -e
# */15 * * * * cd /opt/dbx-demo && ./reset.sh >> /var/log/dbx-demo-reset.log 2>&1
```

建议挂在 Cloudflare 等反代之后，用 WAF/限流保护源站 4224 端口。

## 安全模型（为什么可以公开）

三层防线叠加，缺一不可：

1. **`DBX_DEMO_MODE=1`（服务端封锁，见 `crates/dbx-web/src/demo.rs`）**：
   - 封锁插件安装 / JDBC / 驱动管理（sidecar 原生进程 = 远程代码执行）；
   - 封锁连接探测与增删改（`connection/test*`、`connection/save`、
     `mq/nacos test-connection` 等 body 携带完整连接配置的 SSRF 入口）；
   - 封锁 AI 供应商配置与外呼、云同步凭据、口令改写、凭据解密；
   - `/connection/connect` 保留但要求连接已预置且端点身份与存储一致。
2. **`internal: true` 网络（网络层兜底）**：dbx-web 容器无法主动出网，
   即使有遗漏的出网入口也在网络层被挡掉；对外只发布 4224。
3. **定时重置**：`reset.sh` 销毁全部数据卷，任何数据破坏 15 分钟内自愈。

### 已知的共享实例固有行为（非漏洞，属产品形态）

所有访客共享同一工作台：查询历史、SQL 片段、布局互通；任一访客断开连接
会中断该连接上其他访客的查询。介意时可升级为每访客临时实例编排（同一镜像
与封锁开关可直接复用，按访客拉起独立 compose 项目即可）。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 基于官方发布镜像叠加播种入口 |
| `docker-compose.yml` | 演示栈编排（internal 网络 + 演示库健康检查） |
| `seed/entrypoint.sh` | 首次启动时在未发布端口播种预置连接后转正式模式 |
| `seed/connections.json` | 预置的三条演示连接 |
| `seed/sql/postgres/init.sql` / `seed/sql/mysql/init.sql` | 演示库示例数据（迷你电商） |
| `reset.sh` | 定时全量重置 |

## 前端适配（可选跟进）

`GET /api/version` 现返回 `demoMode` 标志，前端可据此隐藏"新建连接"等入口并
展示演示横幅；服务端 403（`DEMO_MODE_DISABLED`）已足够兜底。

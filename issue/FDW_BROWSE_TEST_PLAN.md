# FDW 体系浏览 — 手动测试步骤

> **仅供测试者阅读，不入 PR、不入库。**
>
> 测试环境需一个可连接的 PostgreSQL 实例（≥ 9.1，推荐 ≥ 12）。
> 可选：一个 Kingbase 实例用于 agent fallback 路径验证。

---

## 前置准备

1. 启动 dbx 桌面端（`make dev-fast` 或 Tauri 打包版本）
2. 连接一个 PostgreSQL 数据库（确保连接成功，侧边栏出现数据库节点）
3. （可选）创建 Foreign Server / User Mapping 用于验证：

```sql
-- 如果没有 FDW 先安装
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- 创建测试 Foreign Server
CREATE SERVER test_fdw_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'localhost', dbname 'test');

-- 创建测试 User Mapping
CREATE USER MAPPING FOR CURRENT_USER
  SERVER test_fdw_server
  OPTIONS (user 'testuser', password 'secret');
```

> **注意**：如果 `CREATE EXTENSION postgres_fdw` 报错 "extension not available"，说明 PG 编译时未包含 postgres_fdw。此时浏览功能仍可正常使用，只是三个 group 均为空列表。

---

## 场景 1: 侧边栏树节点展示

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 1.1 | 展开 PostgreSQL 数据库节点 | 子节点列表出现 "Foreign Data Wrappers"、"Foreign Servers"、"User Mappings" 三个 group（位于 Extensions / Event Triggers 附近） | SCREENSHOT_PLACEHOLDER_1_1 |
| 1.2 | 三个 group 图标正确 | FDW→Database 图标，Foreign Servers→Server 图标，User Mappings→Users 图标 | SCREENSHOT_PLACEHOLDER_1_2 |

---

## 场景 2: 加载 Foreign Data Wrappers

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 2.1 | 点击 "Foreign Data Wrappers" 节点 | 展开并加载 FDW 列表（至少包含 `postgres_fdw` 或空列表） | SCREENSHOT_PLACEHOLDER_2_1 |
| 2.2 | 列表中 FDW 名称正确显示 | 名称正确 | SCREENSHOT_PLACEHOLDER_2_2 |
| 2.3 | 右键菜单 | 出现 "View details" + "Copy name" | SCREENSHOT_PLACEHOLDER_2_3 |

---

## 场景 3: Foreign Data Wrapper 详情对话框

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 3.1 | 点击某个 FDW | 弹出详情对话框，标题 "Foreign Data Wrapper Details" | SCREENSHOT_PLACEHOLDER_3_1 |
| 3.2 | 字段检查 | Name/Owner/Handler/Validator/Options/Comment 均正确展示 | SCREENSHOT_PLACEHOLDER_3_2 |
| 3.3 | DDL 预览 | 下方显示重建的 `CREATE FOREIGN DATA WRAPPER "xxx" …` DDL | SCREENSHOT_PLACEHOLDER_3_3 |
| 3.4 | 关闭对话框 | 点击 Close 关闭 | — |

---

## 场景 4: 加载 Foreign Servers

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 4.1 | 点击 "Foreign Servers" 节点 | 展开并加载 Server 列表 | SCREENSHOT_PLACEHOLDER_4_1 |
| 4.2 | 右键菜单 | 出现 "View details" + "Copy name" | SCREENSHOT_PLACEHOLDER_4_2 |

---

## 场景 5: Foreign Server 详情对话框

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 5.1 | 点击某个 Foreign Server | 弹出详情对话框，标题 "Foreign Server Details" | SCREENSHOT_PLACEHOLDER_5_1 |
| 5.2 | 字段检查 | Name/Owner/FDW/Type/Version/Options/Comment 均正确 | SCREENSHOT_PLACEHOLDER_5_2 |
| 5.3 | DDL 预览 | 下方显示重建的 `CREATE SERVER "xxx" … FOREIGN DATA WRAPPER …` DDL | SCREENSHOT_PLACEHOLDER_5_3 |

---

## 场景 6: 加载 User Mappings

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 6.1 | 点击 "User Mappings" 节点 | 展开并加载 Mapping 列表 | SCREENSHOT_PLACEHOLDER_6_1 |
| 6.2 | 列表格式 | 格式为 `"<user>" (<server>)` | SCREENSHOT_PLACEHOLDER_6_2 |
| 6.3 | 非超级用户 | 用非超级用户连接时，只显示当前用户的 mapping | SCREENSHOT_PLACEHOLDER_6_3 |

---

## 场景 7: User Mapping 详情对话框

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 7.1 | 点击某个 User Mapping | 弹出详情对话框，标题 "User Mapping Details" | SCREENSHOT_PLACEHOLDER_7_1 |
| 7.2 | 字段检查 | User / Server / Options 均正确展示 | SCREENSHOT_PLACEHOLDER_7_2 |
| 7.3 | DDL 预览 | 下方显示重建的 `CREATE USER MAPPING FOR … SERVER … OPTIONS (…)` DDL | SCREENSHOT_PLACEHOLDER_7_3 |

---

## 场景 8: 右键菜单复制名称

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 8.1 | FDW 右键 "Copy name" | 剪贴板内容为 FDW 名称 | SCREENSHOT_PLACEHOLDER_8_1 |
| 8.2 | Server 右键 "Copy name" | 剪贴板内容为 Server 名称 | SCREENSHOT_PLACEHOLDER_8_2 |
| 8.3 | User Mapping 右键 "Copy name" | 剪贴板内容为 `"user" (server)` | SCREENSHOT_PLACEHOLDER_8_3 |

---

## 场景 9: 中文 locale（zh-CN）

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 9.1 | 切换到中文 | 设置→语言→简体中文，重启 | SCREENSHOT_PLACEHOLDER_9_1 |
| 9.2 | Tree 节点中文 | "外部数据包装器" / "外部服务器" / "用户映射" | SCREENSHOT_PLACEHOLDER_9_2 |
| 9.3 | 对话框中文 | 三个对话框标题、字段标签均为中文 | SCREENSHOT_PLACEHOLDER_9_3 |

---

## 场景 10: Kingbase agent fallback（可选）

| # | 步骤 | 预期结果 | 截图 |
|---|---|---|---|
| 10.1 | 连接 Kingbase 数据库 | Agent 连接成功 | SCREENSHOT_PLACEHOLDER_10_1 |
| 10.2 | 展开三个 FDW group | 正常加载（走 Kingbase agent → sys/pg catalog fallback） | SCREENSHOT_PLACEHOLDER_10_2 |
| 10.3 | Event Trigger tags | 详情对话框 tags 展示正确（非空）——修复验证 | SCREENSHOT_PLACEHOLDER_10_3 |

---

## 测试结果

| 场景 | 通过 | 备注 |
|---|---|---|
| 1. 树节点展示 | ⬜ | |
| 2. 加载 FDW | ⬜ | |
| 3. FDW 详情 | ⬜ | |
| 4. 加载 Server | ⬜ | |
| 5. Server 详情 | ⬜ | |
| 6. 加载 Mapping | ⬜ | |
| 7. Mapping 详情 | ⬜ | |
| 8. 复制名称 | ⬜ | |
| 9. 中文 locale | ⬜ | |
| 10. Kingbase | ⬜ | |
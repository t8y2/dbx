# DBX Web 认证架构设计说明（精简版）

| 项 | 内容 |
|---|---|
| 状态 | 评审稿（供项目组讨论） |
| 日期 | 2026-11-15 |
| 完整版 | `docs/auth-architecture-design.md`（含 Schema、API/错误码全表、文件索引） |

---

## 1. 背景与范围

Web 形态（`dbx-web`，axum 单二进制 + SPA）需要多用户认证：**本地账号、LDAP、OIDC SSO、自建认证系统（HTTP 回调）、反向代理身份注入**五类身份源，登录后统一收敛为服务端会话。桌面（Tauri）形态维持本地单用户，不在范围内。

**非目标（有意不做）**：细粒度 ACL；工作区数据按用户隔离（当前明确"所有登录用户共享"，见 D2）；桌面登录。

## 2. 总体架构

```
浏览器 SPA ──同源 Cookie──→  dbx-web (axum)
                             中间件流水线：auth_middleware → demo_gate → migration_gate → handler
                             auth/：cookies·handlers·handlers_admin·handlers_oidc·rate_limit·装配
                             约 430 条业务路由统一受门禁，无 per-route 鉴权
                                    │                      │
              trait 注入 ┌──────────▼──────────┐   持久化 ┌──▼─ dbx-core ──────────┐
                        │  dbx-auth（纯抽象层）│          │ auth_users / auth_providers │
                        │  AuthProvider trait │          │ secret_codec：AES-256-GCM   │
                        │  5 实现 + SessionStore│         │ （密钥不落库，env/keyring） │
                        │  AuthUserStore trait │         └─────────────────────────────┘
                        └──────────────────────┘
```

- **分层守护**：`dbx-auth` 不得依赖任何 workspace crate（含 dev/build），存储经 trait 注入，`dbx-web` 提供 SQLite 适配——`scripts/core-architecture.test.mjs` 在 CI 强制。
- **admin 权限**：中间件只管"是否登录"，admin 端点在 handler 内调 `require_admin`（403 `admin_required`）。
- **`/mcp`**：独立 Bearer Token + Origin/Host 校验 + 审计日志，不复用 Web 会话。

## 3. 核心设计决策（已定）

| 主题 | 结论 |
|---|---|
| 会话 | 不透明 UUIDv4 token + **内存** HashMap + `dbx_session` Cookie（HttpOnly、SameSite=Lax、Secure 可选）；TTL 固定（`DBX_WEB_SESSION_TTL_SECS` 可选）；重启即全下线（未决，D1） |
| 身份供给 | `AuthIdentity`（`provider_id + subject` 为稳定键）→ **JIT 供给**：subject 匹配 → username 匹配（回填 subject）→ 建号；外部用户每次登录以 IdP 为准覆盖 profile/role |
| 角色 | Admin / Member 两级；组→角色映射 `role_map`（精确匹配 → `"*"` 通配 → `default_role`） |
| 配置 | 双轨：env `DBX_AUTH_CONFIG(_FILE)`（同 id 覆盖 DB 条目，UI 只读徽标）+ `auth_providers` 表（管理端 UI 全量替换）；秘密字段脱敏回显 |
| 秘密 | AES-256-GCM 信封（AAD 绑定 namespace+key）存 `connection_secrets`；密钥解析：密钥文件 → `DBX_SECRET_KEY` → OS keyring，**绝不落库** |
| OIDC | **手写实现**（未用 openidconnect crate）：Authorization Code + PKCE S256 + state + nonce + JWKS RS256 本地验签 + RP-initiated logout |
| 撤销 | 改密→踢其余保当前；管理员禁用/删除/重置→全踢；登出→烧 token + 清临时连接凭据 + 返回 IdP 登出 URL |

## 4. 关键流程

- **启动门控（前端 `StartupGate`）**：`GET /api/auth/check` → `setup_required`（0 用户且无外部提供者）→ setup 页；未认证 → 登录页；否则迁移向导 → App 懒加载（认证通过才 import App）。
- **表单登录**：`POST /api/auth/login` → 验证码（auto：该账号失败≥1 次触发；一次性）→ 限流（5 次失败锁 60s，per provider+username）→ Argon2 验证 → JIT → `Set-Cookie`。
- **SSO**：`GET /api/auth/oidc/{id}/authorize?next=…`（303→IdP）→ callback（302 + Set-Cookie，`next` 仅站内路径防开放重定向）；失败统一 303→`/login?error={固定码}`。
- **首启**：`POST /api/auth/setup` 仅 0 用户可用，创建 `admin` 并自动登录；`DBX_PASSWORD` 每次启动 upsert admin（语义见 D5）。

## 5. API 面（精简）

| 鉴权 | 端点 |
|---|---|
| 公开 | `POST /auth/login`、`POST /auth/setup`、`GET /auth/captcha`、`GET /auth/check`、`GET /auth/providers`、`GET /auth/oidc/{id}/authorize|callback` |
| 登录 | `POST /auth/change-password`、`POST /auth/logout` |
| Admin | `GET/PUT /auth/admin/providers`（全量替换）、`POST …/providers/test`、`GET/POST /auth/admin/users`、`PATCH/DELETE /auth/admin/users/{id}`、`GET /auth/admin/sessions`（永不回显 token） |

错误契约：401 `invalid_credentials`（防枚举，统一文案）、403 `user_disabled`/`admin_required`、429 限流（文案式，见 D13）、OIDC 错误码 7 个（`oidc_failed` 等）。

## 6. 安全机制（现状）

Argon2id 哈希｜限流+验证码（先验码再计限流，防刷锁/防烧 CPU）｜登录体 64 KiB 限制｜代理身份头每请求剥离 + proxy 提供者 CIDR 白名单｜`next` 开放重定向防护｜秘密加密落库+脱敏回显｜demo 模式阻断 setup/改密/管理端写｜纵深二次校验（改密端点自验 Cookie、PL-debug 会话复核、SQL 日志按会话归属）。

CSRF 无显式 token，依赖 **SameSite=Lax + JSON-only + 无 CORS** 的同源模型（见 D3）。

## 7. 部署要点

- 关键 env：`DBX_PASSWORD`、`DBX_DISABLE_PASSWORD`、`DBX_AUTH_CONFIG(_FILE)`、`DBX_PUBLIC_URL`、`DBX_PUBLIC_BASE_PATH`、`DBX_WEB_SESSION_TTL_SECS`、`DBX_WEB_COOKIE_SECURE`、`DBX_WEB_CAPTCHA`、`DBX_SECRET_KEY(_FILE)`、`DBX_DEMO_MODE`。
- **OIDC redirect_uri 推导**：provider `public_url` > `DBX_PUBLIC_URL` > 请求头（proto+Host）——反代部署**必须**显式配置前两者之一。
- 测试资产：`deploy/auth-smoke.sh`（9 场景端到端）、`deploy/docker-compose.ldap-test.yml`（alice=admin / bob=member）、`deploy/auth-callback-adapter.py`（自建认证替身）、`crates/dbx-web/tests/auth_oidc_http.rs`（真实二进制 + mock IdP 集成测试）。

## 8. 待讨论决策点

| # | 问题 | 建议 |
|---|---|---|
| D1 | 会话纯内存：重启全下线、无法多副本 | 落 `auth_sessions` 表（SQLite） |
| D2 | Member 可见全部连接/数据（共享为有意设计） | 本期文档明示；所有权/共享独立立项 |
| D3 | 无显式 CSRF 防线 | 写方法加 Origin 校验中间件 |
| D4 | Secure Cookie 默认关 | `DBX_PUBLIC_URL` 为 https 时自动附加 |
| D5 | `DBX_PASSWORD` 每次启动覆盖 admin 密码 | 文档明示；或拆分"初始化/轮换"变量 |
| D6 | 无密码策略 | 最小长度 ≥8（env 可调） |
| D7 | LDAP 组映射仅支持 memberOf | 文档标注限制，需要时再做组搜索扩展 |
| D8 | 无审计持久化 | `auth_audit` 表 + 管理端只读查询 |
| D9 | JIT 覆盖管理员对外部用户手工改的角色 | UI 提示；可选用户级 `pinned_role` |
| D10 | OIDC 手写 vs openidconnect crate | 维持手写 + 补测试矩阵（ES256/轮换/skew） |
| D11 | proxy_header 依赖"不可绕过直连"的部署纪律 | 文档指引：收敛 CIDR + 网络层禁直连 |
| D12 | OIDC 无管理端表单（只能 env/DB 预置） | 路线图补齐 |
| D13 | 打包改进 | 429 结构化（`rate_limited`+`retry_after`）、哈希函数收敛进 `dbx-auth` |

## 9. 路线图建议

**本期收尾**（当前工作树：五类提供者 + 会话/限流/验证码 + 管理端 + 前端 Security 页 + 测试与文档）→ **Phase 2 小改**（D3/D4/D6/D8/D13）→ **Phase 3 立项**（D1 会话持久化、D2 所有权与共享、D12 OIDC 表单、PAT/API Token 供 CLI/CI 使用）。

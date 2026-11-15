# DBX Web 认证架构设计方案（评审稿）

| 项 | 内容 |
|---|---|
| 状态 | 评审稿（供项目组讨论，尚未定稿） |
| 日期 | 2026-11-15 |
| 范围 | Web 形态（`dbx-web`）的多用户认证、会话、身份供给与管理；桌面（Tauri）形态维持本地单用户模型，仅在差异处说明 |
| 关联文档 | `docs/content/docs/web-api.mdx`（对外 API 文档）、`crates/ARCHITECTURE.md`（crate 分层）、`scripts/core-architecture.test.mjs`（分层守护）、`README.md` "Multi-user & SSO login" |
| 本文性质 | 第 2–10 章梳理当前工作树**已实现**的架构（含未提交改动）；第 11–13 章为安全分析与**待讨论决策点**，是本次评审重点 |

---

## 1. 背景与目标

DBX 存在两种运行形态：

- **桌面形态（Tauri）**：本地单用户，直接调用本地进程，不经过 HTTP 认证（`isTauriRuntime()` 判定，见 `apps/desktop/src/lib/backend/tauriRuntime.ts`）。
- **Web 形态（`dbx-web`）**：单二进制（axum）+ 内嵌/磁盘静态 SPA，默认监听 `4224` 端口，可能部署在个人 VPS、团队内网或容器中。此形态需要完整的多用户认证。

认证体系要解决的目标：

1. **多种身份源接入**：本地账号（用户名/密码）、LDAP/AD 目录、OIDC SSO、企业自建认证系统（HTTP 回调）、反向代理注入身份（AuthProxy / SSO 网关）。
2. **统一会话**：无论身份源为何，登录后统一收敛为服务端会话 + `dbx_session` Cookie。
3. **管理能力**：管理员可在 UI 中管理认证提供者与用户，也可以用环境变量声明式配置（IaC 友好）。
4. **零依赖抽象**：认证核心沉淀在独立 crate（`dbx-auth`），不依赖任何 workspace 内 crate，存储通过 trait 注入，保证可测试与可复用（未来 CLI/MCP 等入口可复用）。

**非目标（当前版本明确不做）**：

- 不做工作区数据的按用户隔离（所有登录用户共享连接、历史、SQL 等，见决策点 D2）；
- 不做细粒度权限/ACL（仅 Admin / Member 两级）；
- 桌面形态不引入登录。

---

## 2. 总体架构

### 2.1 分层与 crate 职责

```
┌────────────────────────────── apps/desktop (Vue 3 SPA) ─────────────────────────────┐
│  StartupGate → LoginPage / SecurityMigrationWizard → App                             │
│  Settings→Security：WebCurrentUserInfo / WebAuthProvidersSetting / WebAuthUsersSetting│
│  同源 fetch，凭据 = 自动携带的 dbx_session Cookie（无客户端 token 存储）               │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │ HTTP（同源 Cookie）
┌────────────────────────────── dbx-web (axum) ────────────────────────────────────────┐
│ 中间件流水线（外→内）：auth_middleware → demo_mode_gate → migration_gate → handler     │
│                                                                                      │
│  auth/            模块：cookies / handlers / handlers_admin / handlers_oidc /        │
│                   middleware / providers(装配) / rate_limit / user_store(适配)        │
│  routes/*         约 430 条业务路由，统一受 auth_middleware 保护（无 per-route 鉴权）  │
│  /mcp             独立 Bearer Token + Origin/Host 校验 + 审计（不复用 Web 会话）      │
└───────┬──────────────────────────────────────────┬───────────────────────────────────┘
        │ trait 调用                                │ trait 实现 / 持久化
┌───────▼───────────── dbx-auth（零 workspace 依赖）────┐   ┌──── dbx-core persistence ───┐
│ provider.rs   AuthProvider trait / AuthError         │   │ auth_users.rs   用户表 CRUD  │
│ registry.rs   AuthRegistry（整体热替换）              │   │ auth_providers.rs 提供者表    │
│ identity.rs   AuthIdentity / UserRole / map_role     │   │ secret_codec.rs AES-256-GCM  │
│ session.rs    SessionStore（内存 HashMap）            │   │ storage.rs      Storage 门面 │
│ user_store.rs AuthUserStore trait（默认 JIT 供给）    │   └──────────────────────────────┘
│ providers/    local / oidc / ldap / http_callback /  │
│               proxy_header                           │
└──────────────────────────────────────────────────────┘
```

各层职责与关键依赖：

| 层 | Crate / 目录 | 职责 | 关键依赖 |
|---|---|---|---|
| 认证核心 | `crates/dbx-auth/` | Provider 抽象与 5 种实现、身份/角色映射、会话存储、用户存储 trait | `argon2 0.5`、`jsonwebtoken 9`（仅验 id_token）、`ldap3 0.11(tls-rustls)`、`reqwest 0.12`、`uuid`、`sha2` |
| HTTP 适配 | `crates/dbx-web/src/auth/`（`auth.rs` 为 barrel） | Cookie、中间件、登录/管理/OIDC handler、限流、验证码、配置装配、`AuthUserStore` 的 SQLite 适配 | `dbx-auth`、`dbx-core`、`argon2`（哈希） |
| 持久化 | `crates/dbx-core/src/persistence/` | `auth_users`、`auth_providers` 表 CRUD；秘密加密存储 | rusqlite（可选 SQLCipher） |
| 前端 | `apps/desktop/src/` | 启动门控、登录页、管理 UI、错误文案 | 无第三方请求库，原生 fetch |

OIDC 为**手写实现**（`crates/dbx-auth/src/providers/oidc.rs`），未引入 `openidconnect` crate：自行完成发现文档、Authorization Code + PKCE(S256) + state + nonce、Token 交换、JWKS RS256 验签、RP-initiated logout（取舍见 D10）。

### 2.2 分层守护（强制规则）

`scripts/core-architecture.test.mjs:18-40` 中 `allowedDependencies` 明确：

```js
// Auth abstraction layer: depends on no workspace crate (storage is injected from the upper layer via a trait).
"dbx-auth": [],
```

- `dbx-auth` **不得依赖任何 workspace crate，包括 dev/build 依赖**——因此用户存储只能以 trait（`AuthUserStore`）注入，由 `dbx-web/src/auth/user_store.rs` 用 dbx-core 的 `Storage` 实现；
- 该测试同时约束 Dockerfile 必须为每个 workspace crate 建立依赖缓存段（`deploy/Dockerfile:37`、`:76` 为此新增了 `dbx-auth` 条目），CI 强制执行；
- `dbx-web` 未列入白名单，自由依赖 `dbx-auth` + `dbx-core`；目前仅 `dbx-web` 依赖 `dbx-auth`（`crates/dbx-web/Cargo.toml:28`），src-tauri / dbx-cli / dbx-mcp 均未接入。

### 2.3 请求中间件流水线

路由全部嵌套在 `/api` 下（`crates/dbx-web/src/main.rs:1646`），三层中间件在 `main.rs:1638-1642` 依序 `.layer()`，axum 中**最后 layer 的在最外层**，故实际请求顺序为：

```
请求 → auth_middleware → demo_mode_gate → migration_gate → 业务 handler
```

| 中间件 | 位置 | 行为 |
|---|---|---|
| `auth_middleware` | `crates/dbx-web/src/auth/middleware.rs:80-143` | 核心门禁，见下 |
| `demo_mode_gate` | `crates/dbx-web/src/routes/demo.rs:90-125` | `DBX_DEMO_MODE` 下按路径+方法拦截（`auth/setup`、`auth/change-password`、`auth/admin/*` 非 GET、插件/JDBC/Agent/AI 写接口等），返回 403 `DEMO_MODE_DISABLED`；同时禁用代理头自动登录 |
| `migration_gate` | `crates/dbx-web/src/main.rs:164-187` | 数据迁移未就绪时返回 423 `DATA_MIGRATION_REQUIRED`，仅放行 `migration/*`、`ping` 与**全部 `auth/*`** |

`auth_middleware` 决策树：

1. 非 `/api` 路径（SPA 静态资源）→ 放行；
2. `DBX_DISABLE_PASSWORD` 开启（password_disabled 模式）→ 全放行（另有匿名管理员会话，见 5.1）；
3. 公开路径白名单：`auth/login`、`auth/setup`、`auth/captcha`、`auth/providers`、`auth/oidc/*` → 放行；`auth/check` 走独立分支（带代理自动登录）；
4. **剥离代理身份头**（`x-forwarded-user/email/groups/display-name`，`middleware.rs:20,44-54`）——防止客户端伪造；
5. 读 `dbx_session` Cookie → `SessionStore.get` 命中 → 注入 `AuthContext { user_id, role }` 扩展，并在 `with_credential_owner(Some(token), …)` 作用域内执行 handler（会话 token 同时限定该会话的**临时连接凭据**归属）；
6. 未命中 → 尝试 **proxy_header 自动登录**（仅 trusted CIDR、demo 模式禁用），成功则 JIT 建号并 `Set-Cookie`；
7. 其余 → 裸 `401`（无 body）。

角色检查不在中间件做：admin 端点各自开头调用 `require_admin(&AuthContext)`（`handlers_admin.rs:28-34`），非 admin 返回 403 `admin_required`。另有三处**纵深校验**：`change_password` 自行验 Cookie（"不得成为未认证的密码 oracle"）、PL-debug `validated_access`（Cookie token 必须在活会话集合中）、SQL 文件失败日志按会话归属隔离。

---

## 3. 身份与账号模型

### 3.1 核心类型（`crates/dbx-auth/src/`）

| 类型 | 字段 / 语义 |
|---|---|
| `AuthIdentity`（identity.rs:51-59） | `provider_id, subject, username, display_name, email, groups, role`；`subject` = OIDC `sub` / LDAP bind DN / 本地用户 id，是外部身份的稳定键 |
| `UserRole`（identity.rs:13-16） | 仅 `Admin` / `Member` 两级 |
| `AuthUserRecord`（user_store.rs:11-25） | `id, username, display_name, email, password_hash(Argon2 PHC, 可空), role, provider_id, subject, disabled, created_at, updated_at` |
| `SessionRecord`（session.rs:14-23） | `token, user_id, username, provider_id, role, created_at, last_seen, expires_at(可空)` |

### 3.2 角色映射（`map_role`，identity.rs:39-46）

外部身份的 groups → DBX 角色，按序匹配：

1. `role_map` 中**精确**组名（按配置顺序）；
2. `"*"` 通配项；
3. `default_role` 兜底；无法识别的组忽略。

例：`{"ops-admin": "admin", "*": "member"}` —— `ops-admin` 组用户为管理员，其余皆成员。

### 3.3 JIT 供给（`AuthUserStore::get_or_provision`，user_store.rs:55-91）

所有**外部提供者**登录（表单 LDAP / OIDC 回调 / 代理自动登录）统一走默认供给逻辑：

```
按 (provider_id, subject) 查找 ──命中──→ 刷新 profile/role（IdP 为唯一事实源）
        │未命中
按 (provider_id, username) 查找 ──命中──→ 回填 subject（目录改名/迁移场景）
        │未命中
创建新账号（UUID，disabled=false，password_hash=NULL，role=map_role 结果）
```

随后统一做 `disabled` 检查（禁用用户 403）。

> ⚠️ 语义注意（对应 D8）：外部用户**每次登录都会用 IdP 返回值覆盖 username / role / display_name / email**。管理员在 UI 中手工调整外部用户的角色，会在该用户下次登录时被 `role_map` 覆盖回映射结果；`disabled` 标记不受影响（管理员禁用始终生效）。

### 3.4 数据库 Schema（SQLite，幂等 `CREATE TABLE IF NOT EXISTS`，无版本化迁移）

**`auth_users`**（`crates/dbx-core/src/persistence/auth_users.rs:244-262`）：

```sql
CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT, email TEXT, password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    provider_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_auth_users_login ON auth_users(provider_id, username);
CREATE UNIQUE INDEX idx_auth_users_provider_subject ON auth_users(provider_id, subject);
```

**`auth_providers`**（`auth_providers.rs:104-112`）：`id(PK), kind, label, config_json(去秘密), enabled, sort_order, updated_at`。

**`connection_secrets`** 复用（`storage.rs:1222-1228`）：认证提供者秘密以 `connection_id = "auth.providers"`、`key = "{provider_id}.{field}"` 存入既有秘密表（命名空间常量 `AUTH_PROVIDERS_SECRET_NS = "auth.providers"`）。

**无会话表**——会话仅存内存（见 D1）。

**兼容引导**：

- `migrate_legacy_password_admin`（auth_users.rs:194-217）：表为空时把旧版 `app_settings.password_hash` 导入为 `admin` 用户；
- `upsert_local_admin_password`（auth_users.rs:154-188）：`DBX_PASSWORD` 环境变量与首启 setup 共用，**强制** `role='admin', disabled=0`；`DBX_PASSWORD` 在每次启动都会执行（见 D5）。

---

## 4. 认证提供者体系

### 4.1 Provider 契约（`crates/dbx-auth/src/provider.rs:161-211`）

```rust
pub trait AuthProvider: Send + Sync {
    fn id/kind/label/login_mode(&self);  fn public_url(&self) -> Option<&str>;
    async fn authenticate(&self, input: &FormCredentials) -> Result<AuthIdentity, AuthError>;      // 表单路径
    async fn authenticate_proxy(&self, ip: IpAddr, headers: &HeaderMap) -> Option<AuthIdentity>;   // 代理路径
    async fn begin_redirect(&self, redirect_uri: &str, next: Option<&str>) -> Result<RedirectInit, AuthError>;
    async fn complete_redirect(&self, query: &CallbackParams, redirect_uri: &str) -> Result<RedirectOutcome, AuthError>;
    async fn on_logout(&self, username: &str);
    async fn end_session_url(&self, post_logout_redirect: &str) -> Option<String>;                 // SSO 登出
    async fn test(&self) -> Result<(), AuthError>;                                                 // 管理端连通性测试
}
```

三种登录形态：`LoginMode::{Form, Redirect, Proxy}`，前端据此渲染表单 / SSO 按钮 / 不可见自动登录。`AuthError` 枚举：`InvalidCredentials, UserDisabled, RateLimited, ProviderUnavailable, Configuration, UsernameRequired, Unsupported, BadIdentity, Internal`。

`AuthRegistry`（registry.rs）持有 `RwLock<Vec<Arc<dyn AuthProvider>>>`，管理端保存配置后**整体热替换**，无需重启。

### 4.2 五种实现一览

| kind | 登录形态 | 验证方式 | 身份/组来源 | 备注 |
|---|---|---|---|---|
| `local` | Form | Argon2id 验证 `auth_users.password_hash` | 本地表 | 固定 id `"local"`，**无配置行、始终装配**；单本地账号时可省略 username（legacy 兼容） |
| `ldap` | Form | 服务账号 bind → `(uid={username})` 搜索 → 用户密码 bind | `username/displayName/mail/memberOf` 属性 | `{username}` 占位符做 RFC 4515 注入转义；默认 `start_tls=false`、超时 10s |
| `oidc` | Redirect | Authorization Code + **PKCE S256** + state + nonce；id_token RS256 本地 JWKS 验签 | `username_claim`（preferred_username→email→sub 兜底）、`groups_claim`（默认 `groups`） | 支持 endpoint 覆盖、`prompt`、RP-initiated logout |
| `http_callback` | Form | 把 `{username, password}` POST 到企业认证服务（头 `X-DBX-Auth-Secret` 共享秘密） | 响应 JSON 字段路径可配置（`subject_path` 等） | DB 来源的 URL **强制 https**；适配任意自建认证系统 |
| `proxy_header` | Proxy | 信任反向代理注入的头（默认 `X-Forwarded-User` 等） | 头 + groups 头（逗号分隔） | 仅接受 `trusted_proxies` CIDR 内来源（默认仅 loopback）；登出有 5 分钟宽限防止 SSO 网关立刻回灌 |

各 kind 的秘密字段（`SECRET_FIELDS_BY_KIND`，`crates/dbx-web/src/auth/providers.rs:38-48`）：`ldap.bind_password`、`oidc.client_secret`、`http_callback.shared_secret`。

### 4.3 配置来源与合并

```
env：DBX_AUTH_CONFIG / DBX_AUTH_CONFIG_FILE（JSON 数组，ProviderConfigEntry）
        │  按 id 覆盖同 id 的 DB 行（env 优先；前端展示为只读 "env" 徽标）
DB：auth_providers 表（管理端 UI 全量替换写入）+ connection_secrets（秘密）
        ↓ 启动时 / 保存后装配（main.rs:673-675，providers.rs:161-200）
AuthRegistry：内置 local 永远第一 + env 条目 + DB 条目
```

装配失败仅降级（保底 local），并打 warn 日志。管理端列表响应中秘密字段**脱敏为 null** 并附 `has_secrets`；保存时"空串=清除、缺省=保留旧值"。

### 4.4 秘密加密存储（`crates/dbx-core/src/persistence/secret_codec.rs`）

- 信封格式 `dbxenc1.<b64nonce>.<b64ciphertext>`，**AES-256-GCM**，AAD 绑定 `(namespace, key)`；
- 密钥（32B）**绝不落库**，解析顺序（secret_codec.rs:159-192）：
  1. `DBX_SECRET_KEY_FILE`（密钥文件）
  2. `DBX_SECRET_KEY`（base64/hex 原始密钥；口令则经 Argon2id `19MiB/t=2/p=1` 派生，固定盐 `dbx-local-secret-store-v1`）
  3. 策略兜底：OS 凭据库（macOS Keychain / Windows CredMan / Linux Secret Service，服务名 `com.dbx.app.secret-store.v1`）或托管数据目录密钥文件；
- 错误码：`SECRET_KEY_INVALID`、`SECRET_KEY_MISMATCH`、`KEY_PROVIDER_UNAVAILABLE` 等；
- 读取时机会式地把遗留明文行重写为密文。

---

## 5. 会话管理

### 5.1 SessionStore（`crates/dbx-auth/src/session.rs`）

- **纯内存** `tokio::RwLock<HashMap<String, SessionRecord>>`；**无 DB 会话表**；
- Token 为 **UUIDv4 不透明串**（session.rs:61-64）——本地不签发任何 JWT（`jsonwebtoken` 仅用于验证 IdP 的 id_token）；
- TTL 为**固定绝对过期**（自创建起算，`DBX_WEB_SESSION_TTL_SECS` 可选；`last_seen` 会更新但**不**滑动续期）；
- 过期清理：读时惰性丢弃 + 后台 sweeper 每 60s 扫描（middleware.rs:191-204）；
- 撤销 API：`remove`（登出烧 token）、`revoke_user_except`（改密保当前会话踢其余）、`revoke_user`（管理员禁用/删除/重置密码全踢）、`retain_only`；
- `register_anonymous`：password_disabled 模式提供匿名管理员会话（配合 PL-debug bootstrap 发 Cookie）；
- **重启即全体下线**（对外文档已明示"Sessions live in the current Web process"，web-api.mdx:88）。

### 5.2 Cookie 语义（`crates/dbx-web/src/auth/cookies.rs:16-24`）

```
Set-Cookie: dbx_session={uuid}; Path={DBX_PUBLIC_BASE_PATH|/}; HttpOnly; SameSite=Lax[; Secure]
登出：      dbx_session=; Path=…; HttpOnly; Max-Age=0
```

- 无 `Max-Age`/`Expires` → 浏览器会话 Cookie，服务端 TTL 才是真实寿命；
- `Secure` 仅在 `DBX_WEB_COOKIE_SECURE=1|true` 时附加（LAN/HTTP 部署的显式选择，见 D4）；
- `/api/*` **只认 Cookie，不接受 Bearer/Authorization 头**；Bearer 仅 `/mcp` 独立使用；无 CORS 层（同源专用）。

### 5.3 生命周期与撤销语义汇总

| 事件 | 会话动作 |
|---|---|
| 登录/SSO 回调/代理自动登录/首启 setup | `create` + `Set-Cookie`（setup 成功即自动登录） |
| 修改密码（自助） | `revoke_user_except`：保留当前会话，踢掉该用户其余会话 |
| 管理员禁用/删除/重置密码 | `revoke_user`：该用户全部会话踢出；自我删除被拒（409 `cannot_delete_self`） |
| 登出 | 烧 token、清 Cookie、清该会话的临时连接凭据；Redirect 类提供者额外返回 `logout_url`（IdP end-session + `post_logout_redirect_uri`），前端整页跳转，避免 IdP 侧 SSO 会话静默回灌 |
| 进程重启 | 全部会话消失 |

### 5.4 会话与连接凭据联动

`with_credential_owner(Some(token), …)` 使**会话内临时解锁的连接凭据**以会话 token 为归属：登出/被踢后这些临时凭据一并清除（`session_credentials.clear_owner`），不会残留到下一个持同一账号的用户会话中。

---

## 6. HTTP API 契约

### 6.1 认证端点清单（均在 `/api` 下）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | 公开 | body `{username?, password, provider?, captcha_id?, captcha_code?}`；单本地账号可省 `username/provider`（legacy）。成功 `Set-Cookie` + `{ok, user:{username, role, provider_id}}` |
| GET | `/auth/captcha` | 公开 | 204=无需验证码；200=`{id, image(dataURL), expires_in:300}`，`no-store` |
| GET | `/auth/check` | 公开* | SPA 启动探测：`{authenticated, required, setup_required, providers[], user?}`；*带代理自动登录分支 |
| POST | `/auth/setup` | 公开（仅 0 用户可用） | 首启创建本地管理员（默认用户名 `admin`），Argon2 哈希，成功即自动登录 |
| POST | `/auth/change-password` | 登录 | `{old_password, new_password}`；旧密码 Argon2 验证；外部身份用户返回 400 `external_user_password` |
| POST | `/auth/logout` | 登录（无 Cookie 也 200 no-op） | 返回 `{ok, logout_url?}` |
| GET | `/auth/providers` | 公开 | 提供者列表（id/kind/label/mode/requires_username） |
| GET | `/auth/oidc/{id}/authorize` | 公开 | 303 → IdP 授权页（`next` 为站内回跳路径）；失败 303 → `{base}/login?error={code}` |
| GET | `/auth/oidc/{id}/callback` | 公开 | 成功 **302** + `Set-Cookie` + `Location: {next}`；失败 303 → `/login?error={code}` |
| GET/PUT | `/auth/admin/providers` | Admin | 列表 / **全量替换**（仅 DB 来源条目可写；env 条目只读） |
| POST | `/auth/admin/providers/test` | Admin | `{kind, config}` 连通性测试 |
| GET/POST | `/auth/admin/users` | Admin | 用户列表 / 创建本地用户 |
| PATCH/DELETE | `/auth/admin/users/{id}` | Admin | 角色、禁用、重置密码 / 删除 |
| GET | `/auth/admin/sessions` | Admin | 活跃会话列表（**永不返回 token**） |

其余约 430 条业务路由（连接、schema、查询、导出、MQ、AI、插件……）统一由 `auth_middleware` 保护，无 per-route 鉴权代码；`/mcp` 独立 Bearer + Origin/Host 校验 + 每次决策写审计日志（`dbx-mcp/src/http_auth.rs`）。

### 6.2 错误码

| 场景 | 码 | body |
|---|---|---|
| 密码/凭证错误 | 401 | `{"error":"invalid_credentials"}` |
| 用户被禁用 | 403 | `{"error":"user_disabled"}` |
| 登录限流 | 429 | `{"error":"Please try again in {n}s"}`（**文案式**，前端按模式匹配翻译，见 6.2 改进项） |
| 缺 username | 400 | `{"error":"username_required"}` |
| 无表单提供者 / 提供者无效 | 403/400 | `setup_required` / `invalid_provider`、`provider_required` |
| 验证码错误 | 400 | `{"error":"captcha_invalid"}` |
| 非 admin 访问管理端 | 403 | `{"error":"admin_required"}` |
| 用户名冲突 / 自删 | 409 | `username_exists` / `cannot_delete_self` |
| OIDC 回调失败 | 303→`/login?error=` | `invalid_credentials / user_disabled / rate_limited / oidc_misconfigured / oidc_unavailable / oidc_failed / invalid_provider` |
| 未认证 API | 401 | 裸 401（无 body） |
| 迁移未就绪 | 423 | `{"code":"DATA_MIGRATION_REQUIRED"}` |

---

## 7. 前端认证流程

### 7.1 启动状态机（`apps/desktop/src/StartupGate.vue`）

```
启动 → (桌面形态?) ──是──→ 跳过认证，直接 migration.initialize()
        │否（Web 形态）
        ▼
GET /api/auth/check ──异常──→ StartupLoading 错误态（可重试）
        │
        ├─ setup_required=true ──────────→ LoginPage（setup 模式，URL→/login）
        ├─ required && !authenticated ───→ LoginPage（登录模式，URL→/login）
        └─ 其余 ──→ SecurityMigrationWizard（如迁移阻塞） → 懒加载 <App>（App 模块
                    整体延迟到认证完成后才 import，StartupGate.vue:14-28）
```

`App.vue` 内部镜像同样的门控：未携带 `startupAuthentication` 深链进入时会补一次 `/auth/check`；SSE 订阅（连接活跃度等）在 `appReady` 后才建立。`setup_required` 判定在后端：**无任何用户且无外部提供者**才为 true——纯 SSO 部署（只有外部提供者、无本地用户）不会进 setup 流程。

### 7.2 登录页（`LoginPage.vue`）

- 提供者分两类渲染：`mode=form` → 用户名/密码表单（多个表单提供者时显示单选按钮组，此时请求才携带 `provider` 字段；`requires_username` 控制是否显示用户名输入）；`mode=redirect` → SSO 按钮，**整页跳转** `GET /api/auth/oidc/{id}/authorize?next={当前路径+查询串}`；`mode=proxy` 不渲染（自动登录不可见）；
- 验证码：挂载时拉取 `/auth/captcha`，204 隐藏输入框；**每次失败后刷新**（挑战一次性消费）；setup 模式不拉验证码；
- 回调错误：`?error=` 查询参数经 `translateBackendError` 翻译展示后用 `history.replaceState` 擦除；
- 全程同源 fetch，无客户端 token 存储。

### 7.3 管理端（Settings → Security，仅 Web 形态显示）

| 组件 | 能力 | 调用端点 |
|---|---|---|
| `WebCurrentUserInfo.vue` | 当前用户名/角色/提供者 | `GET /auth/check` |
| 内嵌改密表单 | 自助改密 | `POST /auth/change-password` |
| `WebLoginCaptchaSetting.vue` | 验证码模式 always/auto/off（env 固定时只读） | `GET/PUT /app-settings/web-login-captcha` |
| `WebAuthProvidersSetting.vue` | LDAP / HTTP 回调提供者的增删改、启停、排序、连通性测试；env 条目只读徽标；秘密字段"留空=保留"占位 | `GET/PUT /auth/admin/providers`、`POST …/providers/test` |
| `WebAuthUsersSetting.vue` | 创建本地用户、改角色、禁用/启用、重置密码（仅 `has_password`）、删除（confirm 弹窗）；JIT 用户同样可禁用/删除 | `GET/POST /auth/admin/users`、`PATCH/DELETE /auth/admin/users/{id}` |

前端**不做** admin 门控（Security 标签对所有登录用户可见），越权由服务端 403 拦截，组件仅展示错误体。OIDC 提供者暂无管理端创建表单（只能 env/DB 预置）——见 D9/路线图。

### 7.4 错误码→文案映射（`src/i18n/backend-errors.ts`）

精确码：`invalid_credentials→auth.loginFailed`、`user_disabled→auth.userDisabled`、`provider_required/invalid_provider`、`external_user_password`、`username_required`、`oidc_failed/oidc_unavailable/oidc_misconfigured`；模式匹配：`Please try again in {N}s → auth.rateLimited`、`captcha_invalid`。测试（`backendErrors.spec.ts`）把 Rust 源码中的字面量与 14 种 locale 的 key 存在性双向钉死。

---

## 8. 安全防护机制（现状清单）

| 机制 | 实现要点 |
|---|---|
| 密码哈希 | Argon2id 默认参数（19 MiB / t=2 / p=1），随机盐，PHC 串入库 |
| 登录限流 | 每 `(provider_id, username)` 5 次失败 → 锁 60s；键数上限 2048 防内存膨胀；仅 `InvalidCredentials` 计数 |
| 验证码 | always/auto/off（默认 auto：该账号≥1 次失败后出现）；5 字符、300s TTL、≤512 待验证、一次性；**先验码再计限流**，防恶意刷锁、防机器人烧 Argon2 CPU |
| 请求体限制 | 登录/setup/改密 64 KiB（在路由层限制，避免未认证缓冲大 body 的 DoS） |
| Cookie | HttpOnly + SameSite=Lax；Secure 可选；Path 跟随子路径部署 |
| CSRF | 无 token——依赖 SameSite=Lax（跨站 POST 不带 Cookie）+ 全接口 JSON body + 无 CORS 的同源模型 |
| 开放重定向 | OIDC `next` 仅接受站内绝对路径，阻断 `//`、`\`、CR/LF（`handlers_oidc.rs:27-41`） |
| 代理头伪造 | 中间件对每个请求先剥离 `x-forwarded-*` 身份头；`proxy_header` 提供者只信任 CIDR 白名单来源 IP |
| 秘密保护 | 提供者秘密 AES-256-GCM 加密落库、密钥不落库、管理端脱敏回显；MCP 设置写入需额外头 `x-dbx-mcp-settings: 1` |
| OIDC | PKCE S256 + state + nonce + JWKS RS256 本地验签；redirect_uri 三级来源（provider `public_url` > `DBX_PUBLIC_URL` > `x-forwarded-proto`+Host） |
| 枚举防护 | 登录失败统一 `invalid_credentials`（不区分"用户不存在"）；管理端会话列表不回显 token |
| Demo 模式 | 阻断 setup/改密/管理端写/AI 出网；连接限定预置目标；`/mcp` 整体 403 |
| 纵深防御 | 改密端点自行验 Cookie；PL-debug 二次会话校验；SQL 失败日志按会话归属隔离 |

---

## 9. 部署与运维

### 9.1 环境变量总表

| 变量 | 作用 |
|---|---|
| `DBX_PASSWORD` | 启动时 upsert 本地 admin 密码（每次启动执行，见 D5） |
| `DBX_DISABLE_PASSWORD` | 关闭密码保护（内网/受信环境） |
| `DBX_AUTH_CONFIG` / `DBX_AUTH_CONFIG_FILE` | 声明式提供者配置（JSON 数组；同 id 覆盖 DB 条目） |
| `DBX_PUBLIC_URL` | 反代后的对外 origin（OIDC redirect_uri 推导） |
| `DBX_PUBLIC_BASE_PATH` | 子路径部署（如 `/dbx`），Cookie Path 随之 |
| `DBX_WEB_SESSION_TTL_SECS` | 服务端会话绝对 TTL（不设=进程生命周期内有效） |
| `DBX_WEB_COOKIE_SECURE` | 强制 Secure Cookie（HTTPS 部署） |
| `DBX_WEB_CAPTCHA` | 钉死验证码策略（always/auto/off），设值后 UI 不可改（409 `captcha_env_locked`） |
| `DBX_SECRET_KEY` / `DBX_SECRET_KEY_FILE` | 秘密库加密密钥（生产建议挂密钥文件） |
| `DBX_DEMO_MODE` | 演示模式（见 §2.3/§8） |
| `DBX_DISABLE_PASSWORD_VIEWER` | 关闭"密码查看"能力（配合前端 `initializePasswordViewerCapability`） |
| `DBX_PORT` / `DBX_BIND_ADDR` | 监听（默认 4224 / 0.0.0.0） |
| `DBX_DATA_DIR` / `DBX_STATIC_DIR` | 数据目录 / 静态资源（镜像内 `/app/data`、`/app/static`） |

### 9.2 反向代理与 redirect_uri

推荐生产拓扑：`浏览器 → TLS 反代 → dbx-web`。OIDC 回调地址推导优先级：provider 配置 `public_url` > `DBX_PUBLIC_URL` > 请求头 `x-forwarded-proto` + `Host`。**反代部署必须显式配置前两者之一**，否则 Host 头可被利用构造回调。若使用 SSO 网关（如 oauth2-proxy、Traefik ForwardAuth）注入身份头，则配置 `proxy_header` 提供者并把网关网段加入 `trusted_proxies`，且确保 dbx-web **不可被绕过网关直接访问**。

### 9.3 容器化

`deploy/Dockerfile`：三段构建（前端 pnpm → Rust zigbuild 交叉编译 amd64/arm64 → bookworm-slim），最终镜像仅含 `dbx-web` 二进制 + 静态 dist，`EXPOSE 4224`。为满足架构测试的 workspace 缓存完整性，依赖阶段新增了 `dbx-auth` 的 COPY 段。

### 9.4 测试/演示环境（随本次改动新增）

| 资产 | 用途 |
|---|---|
| `deploy/docker-compose.ldap-test.yml` + `deploy/ldap-test/seed.ldif` | 一键拉起 bitnami/openldap:2.6（1389 端口，memberOf overlay），预置 `alice`（dbx-admins 组→admin）与 `bob`（无组→member），用于手动验证 LDAP 提供者；注释明确限制：**无 memberOf 的目录（纯 groupOfNames）需要组搜索扩展**（见 D7） |
| `deploy/auth-callback-adapter.py` | 零依赖演示"企业认证系统"：`POST /auth` 校验 `X-DBX-Auth-Secret`，内置 `demo/demo123→ops-admin`、`viewer/viewer123`，返回 identity JSON |
| `deploy/auth-smoke.sh` | 端到端冒烟（9 组场景）：setup→建号→角色隔离→改密轮换→代理自动登录 JIT→回调登录→登出烧会话→限流回归；以 `--no-default-features --features sqlite-sqlcipher` 最小特性构建，证明认证不依赖可选特性 |
| `tests/auth/auth_*.json` | `DBX_AUTH_CONFIG` 样例（ldap/oidc/http_callback/proxy/all），供手动冒烟挂载 |

---

## 10. 测试策略现状

| 层 | 资产 | 覆盖 |
|---|---|---|
| 单元 | `dbx-auth` 内部测试（dev-dep axum 起 mock IdP）、captcha/rate_limit/role_map | PKCE、组映射、限流语义 |
| HTTP 集成 | `crates/dbx-web/tests/auth_oidc_http.rs`（真实二进制 + 进程内 mock IdP，RSA-2048 JWKS） | ① OIDC 全流程：authorize 303→PKCE 校验→callback 302 + Set-Cookie→角色映射 `ops-admin→admin`；② legacy 密码登录与 401；③ RP-initiated logout 的 `logout_url` 与会话焚烧 |
| 冒烟 | `deploy/auth-smoke.sh` | 上述 9 组端到端场景（curl 级） |
| 前端 | `LoginPage.spec.ts`、`startupAuthentication.spec.ts`、`WebCurrentUserInfo.spec.ts`、`backendErrors.spec.ts` | 验证码流转、payload 形态、additive 解析、错误码→14 locale 文案钉死 |
| 架构守护 | `scripts/core-architecture.test.mjs`（CI） | `dbx-auth` 零 workspace 依赖；Dockerfile 缓存段完整性 |

---

## 11. 安全分析与开放风险

以下是评审需要正视的问题清单（每条与 §12 决策点对应）：

1. **会话不持久**（D1）：内存会话 → 进程重启全体下线；无法水平扩多副本（会话与验证码、限流计数同为进程内状态）；滚动发布会打断在线用户。
2. **权限粒度与数据共享**（D2）：Admin/Member 两级，且 Member 可访问**全部**连接与数据（含查询、导出、AI 配置）。多用户团队部署下"谁能看到谁的服务器凭据"是产品定位级问题——`identity.rs` 文档注释明确写了 "workspace data is shared"，属于有意设计，但需要项目组确认边界。
3. **CSRF 无显式 token**（D3）：SameSite=Lax + JSON-only + 无 CORS 在当前语义下是成立的（Lax 阻止跨站 POST/Fetch 携带 Cookie），但它是"浏览器行为假设"而非应用层强制；未来若引入 iframe 嵌入（需 SameSite=None）即失效。
4. **Secure Cookie 默认关**（D4）：HTTP 明文部署下会话 Cookie 可被链路嗅探；当前靠部署者自觉配 `DBX_WEB_COOKIE_SECURE`。
5. **`DBX_PASSWORD` 每次启动覆盖 admin 密码**（D5）：env 常驻时，用户在 UI 改的密码重启即被重置——与"编排里轮换 secret"场景冲突时的行为需要明确。
6. **无密码策略**（D6）：setup/建号/改密仅校验非空；无最小长度/复杂度。Argon2 用默认参数，低配容器上可能过重/过轻。
7. **无审计持久化**（D8）：登录成败、锁定、管理员操作只有 TraceLayer 请求日志与零散 warn，无可查询的审计轨迹（仅 `/mcp` 有结构化 audit 日志）。
8. **JIT 覆盖语义**（D9）：外部用户每次登录被 IdP 覆盖 profile/role——管理员手工提权会被覆盖回来，UI 未提示。
9. **LDAP 组映射局限**（D7）：仅支持 `memberOf` 属性；纯 groupOfNames / AD 特殊部署需组搜索扩展。
10. **OIDC 手写实现**（D10）：已覆盖主流流程，但缺少完整算法矩阵测试（如 ES256）、JWKS 轮换边界、clock skew 容忍等；`openidconnect` crate 可换成熟度。
11. **proxy_header 信任模型**（D11）：安全性完全取决于"dbx 不可绕过代理直连"这一部署纪律，代码层无法自证。
12. **登录限流文案非结构化**（改进项）：429 返回句子而非 `{"error":"rate_limited","retry_after":n}`，前端靠正则翻译，易碎。
13. **密码哈希位置分裂**（改进项）：验哈希在 `dbx-auth/local.rs`，建哈希分散在 `dbx-web` 的 4 处 handler + main.rs——可收敛进 `dbx-auth`（如 `hash_password` 工具函数），降低参数漂移风险。

---

## 12. 待讨论决策点（本次评审重点）

> 每条给出选项与建议倾向，请项目组裁决。

**D1. 会话持久化方案**
- 背景：见风险 1。
- 选项：A. 维持内存（明确单副本定位）；B. 落 `auth_sessions` 表（SQLite，sweeper 定期清理，重启可续）；C. 改无状态 JWT（牺牲主动撤销能力，不建议）。
- **建议：B**。复用现有 SQLite + 幂等建表机制，成本可控，且为多副本铺路。TTL/滑动过期语义可一并在此讨论（当前 `last_seen` 已记录但未用于续期）。

**D2. 权限模型与数据共享边界（产品定位级）**
- 选项：A. 维持全共享（协作定位，文档明示）；B. 引入连接/凭据所有权 + 共享/分组；C. 增加 Viewer 只读角色。
- **建议：分两步**——本期至少明确文档与 UI 提示"Web 多用户共享工作区"；将"连接所有权 + 共享"列为独立立项，不混入认证主线。

**D3. 是否增加显式 CSRF 防线**
- 选项：A. 维持现状（SameSite=Lax + JSON）；B. 增加轻量 Origin/Referer 校验中间件（对写方法）；C. 双提交 Cookie token。
- **建议：B**——一个中间件即可，代价小，消除对浏览器行为的单点依赖。

**D4. Secure Cookie 策略**
- **建议**：当 `DBX_PUBLIC_URL` 为 `https://` 时自动附加 `Secure`，`DBX_WEB_COOKIE_SECURE` 保留为显式覆盖（可关可强制开）。

**D5. `DBX_PASSWORD` 启动覆盖语义**
- 选项：A. 维持每次启动强制重置（编排轮换 secret 的场景友好）；B. 仅在 admin 不存在/密码为空时生效；C. 增加独立变量（如 `DBX_PASSWORD_ROTATE`）区分"初始化"与"轮换"。
- **建议：C 或 A+文档明示**，关键是把行为写进 README 与 UI 提示，避免"改密失效"的困惑工单。

**D6. 密码策略与 Argon2 参数**
- **建议**：setup/建号/改密统一最小长度（如 ≥8，可 env 调）；Argon2 参数暂维持默认并记录基线，等有低配环境反馈再暴露 env。

**D7. LDAP 组搜索扩展**
- **建议**：本期不做，文档标注限制（seed.ldif 已注明）；若客户场景出现纯 groupOfNames 目录，再实现 `group_filter/member_attr` 配置。

**D8. 审计日志**
- **建议**：新增 `auth_audit` 表（事件：login_ok / login_fail / lockout / logout / admin_* / setup），管理端加只读查询页；保留期复用数据目录清理策略。与 D1 同属"加表"类工作，可同期落地。

**D9. JIT 覆盖与角色固定**
- **建议**：UI 上对外部用户显示"角色由 IdP 映射，本地修改不持久"提示；如需本地提权能力，后续给 provider 配置加 `role_override_users` 或用户级 `pinned_role`。

**D10. OIDC 实现取舍**
- 选项：A. 维持手写 + 补测试矩阵（ES256、JWKS 轮换、skew）；B. 迁移 `openidconnect` crate。
- **建议：A**——手写实现已工作且测试钉住主流程；迁移引入大依赖与行为漂移，收益有限。补测试矩阵列入路线图。

**D11. proxy_header 部署指引**
- **建议**：不改代码，完善文档：要求 `trusted_proxies` 收敛到网关网段 + 网络层禁止绕过直连；可选支持校验代理签名头（如 Traefik ForwardAuth 的 `X-Webauth-*` 场景再议）。

**D12. 管理端补齐 OIDC 表单**
- **建议**：列入路线图（前端 `WebAuthProvidersSetting` 增加 oidc 草稿类型 + issuer 发现预填），减少"必须靠 env 配 SSO"的摩擦。

**D13. 改进项打包**：429 结构化错误码（`rate_limited` + `retry_after`，前后端同步改）、密码哈希函数收敛进 `dbx-auth`、`auth/check` 契约冻结为前端兼容基线。

---

## 13. 演进路线建议

| 阶段 | 内容 | 对应决策点 |
|---|---|---|
| **本期收尾（当前工作树）** | 五类提供者 + 会话/限流/验证码 + 管理端（providers/users/sessions）+ 前端 Security 页 + OIDC 集成测试 + 冒烟/LDAP 环境 + 文档（web-api.mdx / README） | — |
| **Phase 2（评审后小改）** | D3 CSRF 中间件、D4 Secure 自动化、D6 密码策略、D13 打包项、D8 审计表 | D3/D4/D6/D8/D13 |
| **Phase 3（独立立项）** | 会话持久化（D1）、连接所有权与共享（D2）、OIDC 管理端表单（D12）、LDAP 组搜索（D7）、PAT/API Token（供 CLI/CI 复用，当前 CLI 走 `DBX_WEB_URL/DBX_WEB_PASSWORD` 由 MCP 层代理登录，README.md:335-350） | D1/D2/D12/D7 |

---

## 14. 附录：关键文件索引

| 主题 | 文件 |
|---|---|
| Provider 契约/身份/会话/用户 trait | `crates/dbx-auth/src/provider.rs`、`identity.rs`、`session.rs`、`registry.rs`、`user_store.rs` |
| 五种提供者 | `crates/dbx-auth/src/providers/{local,oidc,ldap,http_callback,proxy_header}.rs` |
| HTTP 门禁/Cookie/限流 | `crates/dbx-web/src/auth/{middleware,cookies,rate_limit}.rs`、`crates/dbx-web/src/captcha.rs` |
| 登录/管理/OIDC handler | `crates/dbx-web/src/auth/{handlers,handlers_admin,handlers_oidc}.rs` |
| 配置装配/用户存储适配 | `crates/dbx-web/src/auth/{providers,user_store}.rs` |
| 装配与路由 | `crates/dbx-web/src/main.rs`（路由 686-1636、中间件 1638-1642、引导 575-604） |
| 持久化/秘密 | `crates/dbx-core/src/persistence/{auth_users,auth_providers,secret_codec,storage}.rs` |
| 状态容器 | `crates/dbx-web/src/state.rs` |
| 前端启动/登录 | `apps/desktop/src/StartupGate.vue`、`src/lib/startup/startupAuthentication.ts`、`src/components/auth/LoginPage.vue` |
| 前端管理端 | `apps/desktop/src/components/settings/{WebAuthProvidersSetting,WebAuthUsersSetting,WebCurrentUserInfo}.vue` |
| 错误映射 | `apps/desktop/src/i18n/backend-errors.ts` |
| 部署/测试 | `deploy/Dockerfile`、`deploy/auth-smoke.sh`、`deploy/auth-callback-adapter.py`、`deploy/docker-compose.ldap-test.yml`、`deploy/ldap-test/seed.ldif`、`tests/auth/auth_*.json` |
| 集成测试 | `crates/dbx-web/tests/auth_oidc_http.rs` |
| 分层守护 | `scripts/core-architecture.test.mjs`、`crates/ARCHITECTURE.md` |
| 对外文档 | `docs/content/docs/web-api.mdx`（Authentication 章节）、`README.md`（Multi-user & SSO login） |

//! 请求级用户上下文。
//!
//! 与 [`dbx_core::session_credentials::with_credential_owner`] 的 task-local 模式
//! 一致：[`crate::auth::auth_middleware`] 在请求边界注入当前已认证用户
//! （[`RequestUser`]），下游 handler 与 dbx-core 深层逻辑通过
//! [`current_request_user`] 读取，无需在函数签名上逐层透传。
//!
//! 未注入（桌面端、后台任务、`DBX_DISABLE_PASSWORD=1` 的放行请求、未认证
//! 请求）时 [`current_request_user`] 返回 `None`，调用方按"无用户上下文"
//! 处理（T4 路径权限映射将据此拒绝或放行）。

use std::future::Future;

use dbx_core::persistence::access_control::EffectivePermissions;

/// 当前请求的已认证用户快照。
#[derive(Clone, Debug)]
pub struct RequestUser {
    pub user_id: i64,
    pub username: String,
    pub is_admin: bool,
    /// 当前会话 token（与凭据 owner 作用域一致），预留给未来审计日志使用。
    #[allow(dead_code)]
    pub session_token: String,
    /// 生效权限（管理员为 [`EffectivePermissions::admin`]）。
    pub permissions: EffectivePermissions,
}

impl RequestUser {
    /// 是否拥有指定权限（管理员恒为 true）。
    pub fn has_permission(&self, permission: &str) -> bool {
        self.permissions.has(permission)
    }
}

/// 在一个 future 的整个执行期间设置请求用户上下文。
pub async fn with_request_user<F, T>(user: RequestUser, future: F) -> T
where
    F: Future<Output = T>,
{
    REQUEST_USER.scope(user, future).await
}

/// 读取当前请求的已认证用户；未注入时返回 `None`。
pub fn current_request_user() -> Option<RequestUser> {
    REQUEST_USER.try_get().ok()
}

tokio::task_local! {
    static REQUEST_USER: RequestUser;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_user() -> RequestUser {
        RequestUser {
            user_id: 7,
            username: "alice".to_string(),
            is_admin: false,
            session_token: "token-x".to_string(),
            permissions: EffectivePermissions::default(),
        }
    }

    #[tokio::test]
    async fn request_user_is_visible_inside_scope_and_absent_outside() {
        assert!(current_request_user().is_none());

        let user = sample_user();
        let seen = with_request_user(user, async { current_request_user() }).await;

        let seen = seen.expect("user context must be visible inside the scope");
        assert_eq!(seen.user_id, 7);
        assert_eq!(seen.username, "alice");
        assert_eq!(seen.session_token, "token-x");

        assert!(current_request_user().is_none());
    }

    #[tokio::test]
    async fn scope_survives_awaits_within_the_same_task() {
        let user = sample_user();
        let username = with_request_user(user, async {
            tokio::task::yield_now().await;
            let inner = tokio::time::timeout(std::time::Duration::from_millis(10), async {
                tokio::task::yield_now().await;
                current_request_user()
            })
            .await;
            inner.expect("timeout should not fire").map(|user| user.username)
        })
        .await;
        assert_eq!(username.as_deref(), Some("alice"));
    }
}

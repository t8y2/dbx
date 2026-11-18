//! Login-failure rate limiting.
//!
//! With multiple users, limiting by `(provider_id, username)` keeps one account's failed
//! attempts from locking everyone out; the key count is capped so forged usernames cannot blow up memory.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// Failure-streak cap; reaching it locks the key.
pub const MAX_ATTEMPTS: u32 = 5;
/// Lockout duration (seconds).
pub const LOCKOUT_SECS: u64 = 60;
/// Cap on tracked keys; over the cap, unlocked entries are evicted first, then the map is cleared.
pub const MAX_TRACKED_KEYS: usize = 2048;

#[derive(Default)]
struct LimitEntry {
    fail_count: u32,
    locked_until: Option<Instant>,
}

pub struct LoginRateLimiter {
    entries: Mutex<HashMap<(String, String), LimitEntry>>,
}

impl LoginRateLimiter {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }

    /// Returns `Err(seconds remaining)` when the lockout is active.
    pub async fn check_locked(&self, provider_id: &str, username: &str) -> Result<(), u64> {
        let mut entries = self.entries.lock().await;
        let Some(entry) = entries.get_mut(&(provider_id.to_string(), username.to_string())) else {
            return Ok(());
        };
        if let Some(locked_until) = entry.locked_until {
            let now = Instant::now();
            if locked_until > now {
                return Err((locked_until - now).as_secs().max(1));
            }
            // Lockout expired: reset and count afresh.
            entry.fail_count = 0;
            entry.locked_until = None;
        }
        Ok(())
    }

    /// Records one failure; at `MAX_ATTEMPTS` it locks the key and resets the counter.
    pub async fn record_failure(&self, provider_id: &str, username: &str) {
        let mut entries = self.entries.lock().await;
        if entries.len() >= MAX_TRACKED_KEYS && !entries.contains_key(&(provider_id.to_string(), username.to_string())) {
            entries.retain(|_, entry| entry.locked_until.is_some_and(|until| until > Instant::now()));
            if entries.len() >= MAX_TRACKED_KEYS {
                entries.clear();
            }
        }
        let entry = entries.entry((provider_id.to_string(), username.to_string())).or_default();
        entry.fail_count += 1;
        if entry.fail_count >= MAX_ATTEMPTS {
            entry.locked_until = Some(Instant::now() + Duration::from_secs(LOCKOUT_SECS));
            entry.fail_count = 0;
        }
    }

    /// Resets after a successful login.
    pub async fn reset(&self, provider_id: &str, username: &str) {
        self.entries.lock().await.remove(&(provider_id.to_string(), username.to_string()));
    }

    /// Current failure count for one key (drives the captcha `auto` mode).
    pub async fn failures_for(&self, provider_id: &str, username: &str) -> u32 {
        self.entries
            .lock()
            .await
            .get(&(provider_id.to_string(), username.to_string()))
            .map(|entry| entry.fail_count)
            .unwrap_or(0)
    }

    /// Sum of all failure counts (used by the login page to decide on a captcha).
    pub async fn total_failures(&self) -> u32 {
        self.entries.lock().await.values().map(|entry| entry.fail_count).sum()
    }
}

impl Default for LoginRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(provider: &str, user: &str) -> String {
        format!("{provider}:{user}")
    }

    #[tokio::test]
    async fn locks_after_max_attempts_then_unlocks() {
        let limiter = LoginRateLimiter::new();
        for _ in 0..MAX_ATTEMPTS {
            limiter.record_failure("local", "alice").await;
        }
        let retry = limiter.check_locked("local", "alice").await.unwrap_err();
        assert!(retry > 0 && retry <= LOCKOUT_SECS);
        // Other accounts are unaffected.
        assert!(limiter.check_locked("local", "bob").await.is_ok());
    }

    #[tokio::test]
    async fn reset_clears_lockout() {
        let limiter = LoginRateLimiter::new();
        for _ in 0..MAX_ATTEMPTS {
            limiter.record_failure("local", "alice").await;
        }
        assert!(limiter.check_locked("local", "alice").await.is_err());
        limiter.reset("local", "alice").await;
        assert!(limiter.check_locked("local", "alice").await.is_ok());
    }

    #[tokio::test]
    async fn tracked_keys_are_bounded() {
        let limiter = LoginRateLimiter::new();
        for i in 0..(MAX_TRACKED_KEYS + 100) {
            let user = key("local", &i.to_string());
            limiter.record_failure("local", &user).await;
        }
        let entries = limiter.entries.lock().await;
        assert!(entries.len() <= MAX_TRACKED_KEYS);
    }
}

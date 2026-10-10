//! Execution policy helpers: misfire decisions, retry backoff and concurrency
//! gating. Kept pure so the engine stays thin and the rules stay testable.

use std::time::Duration;

use chrono::{DateTime, Utc};

use super::models::{TaskBackoffStrategy, TaskConcurrencyPolicy, TaskMisfirePolicy, TaskRetryPolicy};
use super::trigger::TaskTrigger;

/// How many missed fires happened between the persisted `next_run_at` and now.
/// Iterates the trigger forward with a generous cap so a bad trigger cannot
/// spin forever. A fire due exactly at `now` is the pending run enqueue_due
/// still has to pick up, so it is not counted as missed.
pub fn count_missed_fires(trigger: &TaskTrigger, next_run_at: DateTime<Utc>, now: DateTime<Utc>) -> u32 {
    let mut missed = 0u32;
    let mut cursor = next_run_at;
    while cursor < now {
        missed += 1;
        if missed >= 1000 {
            break;
        }
        match trigger.next_after(cursor) {
            Ok(Some(next)) => cursor = next,
            // Interval/once triggers that exhausted their schedule stop counting.
            _ => break,
        }
    }
    missed
}

/// Whether a missed schedule window should enqueue a run.
pub fn should_run_misfire(policy: TaskMisfirePolicy) -> bool {
    matches!(policy, TaskMisfirePolicy::Coalesce | TaskMisfirePolicy::FireOnce)
}

/// Delay before the retry attempt of a failed run. `failed_attempt` is the
/// 1-based attempt number that just failed.
pub fn retry_delay(policy: &TaskRetryPolicy, failed_attempt: u32) -> Duration {
    let base = policy.backoff_seconds;
    let seconds = match policy.backoff_strategy {
        TaskBackoffStrategy::Fixed => base,
        TaskBackoffStrategy::Exponential => base.saturating_mul(1u64 << failed_attempt.saturating_sub(1).min(20)),
    };
    Duration::from_secs(seconds)
}

/// Whether a new run of a task may be enqueued under the concurrency policy.
/// `Queue` and `Parallel` allow queuing behind active runs; `Forbid` and
/// `Replace` never queue (replace supersedes at claim time instead).
pub fn allows_enqueue_while_active(policy: TaskConcurrencyPolicy) -> bool {
    matches!(policy, TaskConcurrencyPolicy::Queue | TaskConcurrencyPolicy::Parallel)
}

#[cfg(test)]
mod tests {
    use super::super::models::*;
    use super::*;

    #[test]
    fn exponential_backoff_grows_and_fixed_does_not() {
        let fixed =
            TaskRetryPolicy { max_attempts: 3, backoff_seconds: 30, backoff_strategy: TaskBackoffStrategy::Fixed };
        let exponential = TaskRetryPolicy {
            max_attempts: 4,
            backoff_seconds: 30,
            backoff_strategy: TaskBackoffStrategy::Exponential,
        };
        assert_eq!(retry_delay(&fixed, 1), Duration::from_secs(30));
        assert_eq!(retry_delay(&fixed, 3), Duration::from_secs(30));
        assert_eq!(retry_delay(&exponential, 1), Duration::from_secs(30));
        assert_eq!(retry_delay(&exponential, 2), Duration::from_secs(60));
        assert_eq!(retry_delay(&exponential, 3), Duration::from_secs(120));
    }

    #[test]
    fn misfire_policies_decide_whether_to_run() {
        assert!(should_run_misfire(TaskMisfirePolicy::Coalesce));
        assert!(should_run_misfire(TaskMisfirePolicy::FireOnce));
        assert!(!should_run_misfire(TaskMisfirePolicy::Skip));
        assert!(allows_enqueue_while_active(TaskConcurrencyPolicy::Queue));
        assert!(allows_enqueue_while_active(TaskConcurrencyPolicy::Parallel));
        assert!(!allows_enqueue_while_active(TaskConcurrencyPolicy::Forbid));
        assert!(!allows_enqueue_while_active(TaskConcurrencyPolicy::Replace));
    }

    #[test]
    fn missed_fires_count_stops_at_cap() {
        let trigger = TaskTrigger::Interval { seconds: 60 };
        let now = Utc::now();
        let missed = count_missed_fires(&trigger, now - chrono::Duration::hours(6), now);
        assert_eq!(missed, 360);
        assert_eq!(count_missed_fires(&trigger, now + chrono::Duration::hours(1), now), 0);
    }
}

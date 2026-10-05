//! Trigger tests (plan §84–90): cron across frozen time zones
//! (Asia/Shanghai, America/Los_Angeles, UTC) and DST transitions, plus
//! once/interval/manual semantics.

mod common;

use chrono::{TimeZone, Utc};
use dbx_core::scheduler::{TaskError, TaskTrigger};

fn next(trigger: &TaskTrigger, after: &str) -> chrono::DateTime<Utc> {
    trigger.next_after(after.parse().unwrap()).expect("next_after").expect("trigger fires")
}

#[test]
fn cron_fires_at_local_wall_clock_time_in_asia_shanghai() {
    let trigger = TaskTrigger::Cron { expression: "30 8 * * *".into(), time_zone: "Asia/Shanghai".into() };
    let fired = next(&trigger, "2026-10-05T00:00:00Z");
    assert_eq!(fired, Utc.with_ymd_and_hms(2026, 10, 5, 0, 30, 0).unwrap());
    let fired = next(&trigger, "2026-10-05T00:30:00Z");
    assert_eq!(fired, Utc.with_ymd_and_hms(2026, 10, 6, 0, 30, 0).unwrap());
}

#[test]
fn cron_respects_dst_offset_in_los_angeles() {
    // October 5 2026 is still PDT (UTC-7): 12:00 local = 19:00 UTC.
    let trigger = TaskTrigger::Cron { expression: "0 12 * * *".into(), time_zone: "America/Los_Angeles".into() };
    let fired = next(&trigger, "2026-10-05T00:00:00Z");
    assert_eq!(fired, Utc.with_ymd_and_hms(2026, 10, 5, 19, 0, 0).unwrap());
    // In winter (PST, UTC-8): 12:00 local = 20:00 UTC.
    let fired = next(&trigger, "2026-12-01T00:00:00Z");
    assert_eq!(fired, Utc.with_ymd_and_hms(2026, 12, 1, 20, 0, 0).unwrap());
}

#[test]
fn cron_in_utc_is_plain_wall_clock() {
    let trigger = TaskTrigger::Cron { expression: "0 2 * * *".into(), time_zone: "UTC".into() };
    let fired = next(&trigger, "2026-10-05T00:00:00Z");
    assert_eq!(fired, Utc.with_ymd_and_hms(2026, 10, 5, 2, 0, 0).unwrap());
}

#[test]
fn spring_forward_nonexistent_time_runs_after_the_gap() {
    // US DST starts 2026-03-08: 02:00-03:00 local does not exist in
    // America/Los_Angeles. The frozen rule is "gap 后首刻" → 03:00 PDT.
    let trigger = TaskTrigger::Cron { expression: "30 2 * * *".into(), time_zone: "America/Los_Angeles".into() };
    let fired = next(&trigger, "2026-03-07T11:00:00Z");
    assert_eq!(fired, Utc.with_ymd_and_hms(2026, 3, 8, 10, 0, 0).unwrap());
}

#[test]
fn fall_back_ambiguous_time_takes_the_first_occurrence() {
    // US DST ends 2026-11-01: 01:30 local happens twice (PDT 08:30 UTC, PST
    // 09:30 UTC). The frozen rule is "第一次出现" → 08:30 UTC.
    let trigger = TaskTrigger::Cron { expression: "30 1 * * *".into(), time_zone: "America/Los_Angeles".into() };
    let fired = next(&trigger, "2026-10-31T09:00:00Z");
    assert_eq!(fired, Utc.with_ymd_and_hms(2026, 11, 1, 8, 30, 0).unwrap());
}

#[test]
fn cron_steps_ranges_names_and_weekday_seven() {
    let trigger = TaskTrigger::Cron { expression: "*/15 9-17 * * mon-fri".into(), time_zone: "UTC".into() };
    // 2026-10-05 is a Monday, 00:00 UTC → first fire 09:00.
    assert_eq!(next(&trigger, "2026-10-05T00:00:00Z"), Utc.with_ymd_and_hms(2026, 10, 5, 9, 0, 0).unwrap());

    // 7 is an alias for Sunday: "0 0 * * 7" fires on Sunday 2026-10-04.
    let trigger = TaskTrigger::Cron { expression: "0 0 * * 7".into(), time_zone: "UTC".into() };
    assert_eq!(next(&trigger, "2026-10-01T00:00:00Z"), Utc.with_ymd_and_hms(2026, 10, 4, 0, 0, 0).unwrap());

    // Month names.
    let trigger = TaskTrigger::Cron { expression: "0 0 1 jan *".into(), time_zone: "UTC".into() };
    assert_eq!(next(&trigger, "2026-10-01T00:00:00Z"), Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap());

    // Vixie cron: restricted day-of-month AND day-of-week match on either,
    // so both the 13th and every Friday fire. 2026-11-06 is a Friday,
    // 2026-11-13 is Friday the 13th.
    let trigger = TaskTrigger::Cron { expression: "0 0 13 * fri".into(), time_zone: "UTC".into() };
    assert_eq!(next(&trigger, "2026-11-01T00:00:00Z"), Utc.with_ymd_and_hms(2026, 11, 6, 0, 0, 0).unwrap());
    assert_eq!(next(&trigger, "2026-11-06T00:01:00Z"), Utc.with_ymd_and_hms(2026, 11, 13, 0, 0, 0).unwrap());
}

#[test]
fn invalid_cron_expressions_are_rejected() {
    for expression in ["* * * *", "61 * * * *", "* 25 * * *", "* * 0 * *", "a b c d e", "*/0 * * * *"] {
        let trigger = TaskTrigger::Cron { expression: expression.into(), time_zone: "UTC".into() };
        let error = trigger.next_after(Utc::now()).unwrap_err();
        assert_eq!(error.code, "invalid_config", "expression {expression} should be rejected");
    }
}

#[test]
fn unknown_time_zone_is_rejected() {
    let trigger = TaskTrigger::Cron { expression: "* * * * *".into(), time_zone: "Mars/Olympus".into() };
    let error = trigger.next_after(Utc::now()).unwrap_err();
    assert!(matches!(error, TaskError { code, .. } if code == "invalid_config"));
}

#[test]
fn once_fires_once_then_never_again() {
    let trigger = TaskTrigger::Once { at: "2026-10-06T08:30".into(), time_zone: "Asia/Shanghai".into() };
    assert_eq!(next(&trigger, "2026-10-05T00:00:00Z"), Utc.with_ymd_and_hms(2026, 10, 6, 0, 30, 0).unwrap());
    // Past the fire time: no more fires, but still a valid trigger.
    assert_eq!(trigger.next_after("2026-10-07T00:00:00Z".parse().unwrap()).unwrap(), None);
}

#[test]
fn once_rejects_nonexistent_local_time() {
    // 2026-03-08 02:30 does not exist in America/Los_Angeles.
    let trigger = TaskTrigger::Once { at: "2026-03-08T02:30".into(), time_zone: "America/Los_Angeles".into() };
    let error = trigger.next_after(Utc::now()).unwrap_err();
    assert_eq!(error.code, "invalid_config");
}

#[test]
fn interval_seconds_must_be_bounded() {
    let ok = TaskTrigger::Interval { seconds: 60 };
    assert!(ok.validate().is_ok());
    let zero = TaskTrigger::Interval { seconds: 0 };
    assert_eq!(zero.validate().unwrap_err().code, "invalid_config");
    let huge = TaskTrigger::Interval { seconds: u64::MAX };
    assert_eq!(huge.validate().unwrap_err().code, "invalid_config");
}

#[test]
fn manual_and_startup_triggers_never_schedule() {
    assert_eq!(TaskTrigger::Manual.next_after(Utc::now()).unwrap(), None);
    assert_eq!(TaskTrigger::Startup.next_after(Utc::now()).unwrap(), None);
}

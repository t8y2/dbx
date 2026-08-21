//! Mappings between TDS and and Chrono types (with `chrono` feature flag
//! enabled).
//!
//! The chrono library offers better ergonomy, but is known to hold certain
//! security vulnerabilities. The code here is for legacy purposes, please use
//! `time` crate for greenfield projects.

#[cfg(not(feature = "tds73"))]
use super::DateTime as DateTime1;
#[cfg(feature = "tds73")]
use super::{Date, DateTime2, DateTimeOffset, Time};
use crate::tds::codec::ColumnData;
#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
pub use chrono::offset::{FixedOffset, Utc};
pub use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime};
#[cfg(feature = "tds73")]
use std::ops::Sub;

#[inline]
fn from_days(days: i64, start_year: i32) -> NaiveDate {
    NaiveDate::from_ymd_opt(start_year, 1, 1).unwrap() + chrono::Duration::days(days)
}

#[inline]
fn from_sec_fragments(sec_fragments: i64) -> NaiveTime {
    NaiveTime::from_hms_opt(0, 0, 0).unwrap()
        + chrono::Duration::nanoseconds(sec_fragments * (1e9 as i64) / 300)
}

#[inline]
#[cfg(feature = "tds73")]
fn from_mins(mins: u32) -> NaiveTime {
    NaiveTime::from_num_seconds_from_midnight_opt(mins, 0).unwrap()
}

#[inline]
fn to_days(date: NaiveDate, start_year: i32) -> i64 {
    date.signed_duration_since(NaiveDate::from_ymd_opt(start_year, 1, 1).unwrap())
        .num_days()
}

#[inline]
#[cfg(not(feature = "tds73"))]
fn to_sec_fragments(time: NaiveTime) -> i64 {
    time.signed_duration_since(NaiveTime::from_hms_opt(0, 0, 0).unwrap())
        .num_nanoseconds()
        .unwrap()
        * 300
        / (1e9 as i64)
}

#[cfg(feature = "tds73")]
from_sql!(
    NaiveDateTime:
        ColumnData::SmallDateTime(ref dt) => dt.map(|dt| NaiveDateTime::new(
            from_days(dt.days as i64, 1900),
            from_mins(dt.seconds_fragments as u32 * 60),
        )),
        ColumnData::DateTime2(ref dt) => dt.map(|dt| NaiveDateTime::new(
            from_days(dt.date.days() as i64, 1),
            NaiveTime::from_hms_opt(0,0,0).unwrap() + chrono::Duration::nanoseconds(dt.time.increments as i64 * 10i64.pow(9 - dt.time.scale as u32))
        )),
        ColumnData::DateTime(ref dt) => dt.map(|dt| NaiveDateTime::new(
            from_days(dt.days as i64, 1900),
            from_sec_fragments(dt.seconds_fragments as i64)
        ));
    NaiveTime:
        ColumnData::Time(ref time) => time.map(|time| {
            let ns = time.increments as i64 * 10i64.pow(9 - time.scale as u32);
            NaiveTime::from_hms_opt(0,0,0).unwrap() + chrono::Duration::nanoseconds(ns)
        });
    NaiveDate:
        ColumnData::Date(ref date) => date.map(|date| from_days(date.days() as i64, 1));
    chrono::DateTime<Utc>:
        ColumnData::DateTimeOffset(ref dto) => dto.map(|dto| {
            let date = from_days(dto.datetime2.date.days() as i64, 1);
            let ns = dto.datetime2.time.increments as i64 * 10i64.pow(9 - dto.datetime2.time.scale as u32);
            let time = NaiveTime::from_hms_opt(0,0,0).unwrap() + chrono::Duration::nanoseconds(ns);

            let offset = chrono::Duration::minutes(dto.offset as i64);
            let naive = NaiveDateTime::new(date, time).sub(offset);

            chrono::DateTime::from_naive_utc_and_offset(naive, Utc)
        }),
        ColumnData::DateTime2(ref dt2) => dt2.map(|dt2| {
            let date = from_days(dt2.date.days() as i64, 1);
            let ns = dt2.time.increments as i64 * 10i64.pow(9 - dt2.time.scale as u32);
            let time = NaiveTime::from_hms_opt(0,0,0).unwrap() + chrono::Duration::nanoseconds(ns);
            let naive = NaiveDateTime::new(date, time);

            chrono::DateTime::from_naive_utc_and_offset(naive, Utc)
        });
    chrono::DateTime<FixedOffset>: ColumnData::DateTimeOffset(ref dto) => dto.map(|dto| {
        let date = from_days(dto.datetime2.date.days() as i64, 1);
        let ns = dto.datetime2.time.increments as i64 * 10i64.pow(9 - dto.datetime2.time.scale as u32);
        let time = NaiveTime::from_hms_opt(0,0,0).unwrap() + chrono::Duration::nanoseconds(ns);

        let offset = FixedOffset::east_opt((dto.offset as i32) * 60).unwrap();
        let naive = NaiveDateTime::new(date, time);

        chrono::DateTime::from_naive_utc_and_offset(naive, offset)
    })
);

#[cfg(feature = "tds73")]
to_sql!(self_,
        NaiveDate: (ColumnData::Date, Date::new(to_days(*self_, 1) as u32));
        NaiveTime: (ColumnData::Time, {
            use chrono::Timelike;

            let nanos = self_.num_seconds_from_midnight() as u64 * 1e9 as u64 + self_.nanosecond() as u64;
            let increments = nanos / 100;

            Time {increments, scale: 7}
        });
        NaiveDateTime: (ColumnData::DateTime2, {
            use chrono::Timelike;

            let time = self_.time();
            let nanos = time.num_seconds_from_midnight() as u64 * 1e9 as u64 + time.nanosecond() as u64;
            let increments = nanos / 100;

            let date = Date::new(to_days(self_.date(), 1) as u32);
            let time = Time {increments, scale: 7};

            DateTime2::new(date, time)
        });
        chrono::DateTime<Utc>: (ColumnData::DateTime2, {
            use chrono::Timelike;

            let naive = self_.naive_utc();
            let time = naive.time();
            let nanos = time.num_seconds_from_midnight() as u64 * 1e9 as u64 + time.nanosecond() as u64;

            let date = Date::new(to_days(naive.date(), 1) as u32);
            let time = Time {increments: nanos / 100, scale: 7};

            DateTime2::new(date, time)
        });
        chrono::DateTime<FixedOffset>: (ColumnData::DateTimeOffset, {
            use chrono::Timelike;

            let naive = self_.naive_utc();
            let time = naive.time();
            let nanos = time.num_seconds_from_midnight() as u64 * 1e9 as u64 + time.nanosecond() as u64;

            let date = Date::new(to_days(naive.date(), 1) as u32);
            let time = Time { increments: nanos / 100, scale: 7 };

            let tz = self_.timezone();
            let offset = (tz.local_minus_utc() / 60) as i16;

            DateTimeOffset::new(DateTime2::new(date, time), offset)
        });
);

#[cfg(feature = "tds73")]
into_sql!(self_,
        NaiveDate: (ColumnData::Date, Date::new(to_days(self_, 1) as u32));
        NaiveTime: (ColumnData::Time, {
            use chrono::Timelike;

            let nanos = self_.num_seconds_from_midnight() as u64 * 1e9 as u64 + self_.nanosecond() as u64;
            let increments = nanos / 100;

            Time {increments, scale: 7}
        });
        NaiveDateTime: (ColumnData::DateTime2, {
            use chrono::Timelike;

            let time = self_.time();
            let nanos = time.num_seconds_from_midnight() as u64 * 1e9 as u64 + time.nanosecond() as u64;
            let increments = nanos / 100;

            let date = Date::new(to_days(self_.date(), 1) as u32);
            let time = Time {increments, scale: 7};

            DateTime2::new(date, time)
        });
        chrono::DateTime<Utc>: (ColumnData::DateTime2, {
            use chrono::Timelike;

            let naive = self_.naive_utc();
            let time = naive.time();
            let nanos = time.num_seconds_from_midnight() as u64 * 1e9 as u64 + time.nanosecond() as u64;

            let date = Date::new(to_days(naive.date(), 1) as u32);
            let time = Time {increments: nanos / 100, scale: 7};

            DateTime2::new(date, time)
        });
        chrono::DateTime<FixedOffset>: (ColumnData::DateTimeOffset, {
            use chrono::Timelike;

            let naive = self_.naive_utc();
            let time = naive.time();
            let nanos = time.num_seconds_from_midnight() as u64 * 1e9 as u64 + time.nanosecond() as u64;

            let date = Date::new(to_days(naive.date(), 1) as u32);
            let time = Time { increments: nanos / 100, scale: 7 };

            let tz = self_.timezone();
            let offset = (tz.local_minus_utc() / 60) as i16;

            DateTimeOffset::new(DateTime2::new(date, time), offset)
        });
);

#[cfg(not(feature = "tds73"))]
to_sql!(self_,
        NaiveDateTime: (ColumnData::DateTime, {
            let date = self_.date();
            let time = self_.time();

            let days = to_days(date, 1900) as i32;
            let seconds_fragments = to_sec_fragments(time);

            DateTime1::new(days, seconds_fragments as u32)
        });
);

#[cfg(not(feature = "tds73"))]
into_sql!(self_,
        NaiveDateTime: (ColumnData::DateTime, {
            let date = self_.date();
            let time = self_.time();

            let days = to_days(date, 1900) as i32;
            let seconds_fragments = to_sec_fragments(time);

            DateTime1::new(days, seconds_fragments as u32)
        });
);

#[cfg(not(feature = "tds73"))]
from_sql!(
    NaiveDateTime:
        ColumnData::DateTime(ref dt) => dt.map(|dt| NaiveDateTime::new(
            from_days(dt.days as i64, 1900),
            from_sec_fragments(dt.seconds_fragments as i64)
        ))
);

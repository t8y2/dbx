//! Date and time handling.
//!
//! When using the `tds73` feature flag together with SQL Server 2008 or later,
//! the following [`time`] mappings to and from the database are available:
//!
//! - `Time` -> [`Time`](time/struct.Time.html)
//! - `Date` -> [`Date`]
//! - `DateTime` -> [`PrimitiveDateTime`]
//! - `DateTime2` -> [`PrimitiveDateTime`]
//! - `SmallDateTime` -> [`PrimitiveDateTime`]
//! - `DateTimeOffset` -> [`OffsetDateTime`]
//!
//! With SQL Server 2005 and the `tds73` feature flag disabled, the mapping is
//! different:
//!
//! - `DateTime` -> [`PrimitiveDateTime`]
//! - `SmallDateTime` -> [`PrimitiveDateTime`]
//!
//! [`time`]: time/index.html
//! [`Date`]: time/struct.Date.html
//! [`PrimitiveDateTime`]: time/struct.PrimitiveDateTime.html
//! [`OffsetDateTime`]: time/struct.OffsetDateTime.html

#[cfg(feature = "chrono")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "chrono")))]
pub mod chrono;

#[cfg(feature = "time")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "time")))]
pub mod time;

use crate::{tds::codec::Encode, SqlReadBytes};
#[cfg(feature = "tds73")]
use byteorder::{ByteOrder, LittleEndian};
use bytes::{BufMut, BytesMut};
#[cfg(feature = "tds73")]
use futures_util::io::AsyncReadExt;

/// A presentation of `datetime` type in the server.
///
/// # Warning
///
/// It isn't recommended to use this type directly. For dealing with `datetime`,
/// use the `time` feature of this crate and its `PrimitiveDateTime` type.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct DateTime {
    days: i32,
    seconds_fragments: u32,
}

impl DateTime {
    /// Construct a new `DateTime` instance.
    pub fn new(days: i32, seconds_fragments: u32) -> Self {
        Self {
            days,
            seconds_fragments,
        }
    }

    /// Days since 1st of January, 1900 (including the negative range until 1st
    /// of January, 1753).
    pub fn days(self) -> i32 {
        self.days
    }

    /// 1/300 of a second, so a value of 300 equals 1 second (since midnight).
    pub fn seconds_fragments(self) -> u32 {
        self.seconds_fragments
    }

    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let days = src.read_i32_le().await?;
        let seconds_fragments = src.read_u32_le().await?;

        Ok(Self {
            days,
            seconds_fragments,
        })
    }
}

impl Encode<BytesMut> for DateTime {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.put_i32_le(self.days);
        dst.put_u32_le(self.seconds_fragments);

        Ok(())
    }
}

/// A presentation of `smalldatetime` type in the server.
///
/// # Warning
///
/// It isn't recommended to use this type directly. For dealing with
/// `smalldatetime`, use the `time` feature of this crate and its
/// `PrimitiveDateTime` type.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct SmallDateTime {
    days: u16,
    seconds_fragments: u16,
}

impl SmallDateTime {
    /// Construct a new `SmallDateTime` instance.
    pub fn new(days: u16, seconds_fragments: u16) -> Self {
        Self {
            days,
            seconds_fragments,
        }
    }
    /// Days since 1st of January, 1900.
    pub fn days(self) -> u16 {
        self.days
    }

    /// 1/300 of a second, so a value of 300 equals 1 second (since midnight)
    pub fn seconds_fragments(self) -> u16 {
        self.seconds_fragments
    }

    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let days = src.read_u16_le().await?;
        let seconds_fragments = src.read_u16_le().await?;

        Ok(Self {
            days,
            seconds_fragments,
        })
    }
}

impl Encode<BytesMut> for SmallDateTime {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.put_u16_le(self.days);
        dst.put_u16_le(self.seconds_fragments);

        Ok(())
    }
}

/// A presentation of `date` type in the server.
///
/// # Warning
///
/// It isn't recommended to use this type directly. If you want to deal with
/// `date`, use the `time` feature of this crate and its `Date` type.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
pub struct Date(u32);

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl Date {
    #[inline]
    /// Construct a new `Date`
    ///
    /// # Panics
    /// max value of 3 bytes (`u32::max_value() > 8`)
    pub fn new(days: u32) -> Date {
        assert_eq!(days >> 24, 0);
        Date(days)
    }

    #[inline]
    /// The number of days from 1st of January, year 1.
    pub fn days(self) -> u32 {
        self.0
    }

    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let mut bytes = [0u8; 4];
        src.read_exact(&mut bytes[..3]).await?;
        Ok(Self::new(LittleEndian::read_u32(&bytes)))
    }
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl Encode<BytesMut> for Date {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        let mut tmp = [0u8; 4];
        LittleEndian::write_u32(&mut tmp, self.days());
        assert_eq!(tmp[3], 0);
        dst.extend_from_slice(&tmp[0..3]);

        Ok(())
    }
}

/// A presentation of `time` type in the server.
///
/// # Warning
///
/// It isn't recommended to use this type directly. If you want to deal with
/// `time`, use the `time` feature of this crate and its `Time` type.
#[derive(Copy, Clone, Debug)]
#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
pub struct Time {
    increments: u64,
    scale: u8,
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl PartialEq for Time {
    fn eq(&self, t: &Time) -> bool {
        self.increments as f64 / 10f64.powi(self.scale as i32)
            == t.increments as f64 / 10f64.powi(t.scale as i32)
    }
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl Time {
    /// Construct a new `Time`
    pub fn new(increments: u64, scale: u8) -> Self {
        Self { increments, scale }
    }

    #[inline]
    /// Number of 10^-n second increments since midnight, where `n` is defined
    /// in [`scale`].
    ///
    /// [`scale`]: #method.scale
    pub fn increments(self) -> u64 {
        self.increments
    }

    #[inline]
    /// The accuracy of the increments.
    pub fn scale(self) -> u8 {
        self.scale
    }

    #[inline]
    /// Length of the field in number of bytes.
    pub(crate) fn len(self) -> crate::Result<u8> {
        Ok(match self.scale {
            0..=2 => 3,
            3..=4 => 4,
            5..=7 => 5,
            _ => {
                return Err(crate::Error::Protocol(
                    format!("timen: invalid scale {}", self.scale).into(),
                ))
            }
        })
    }

    pub(crate) async fn decode<R>(src: &mut R, n: usize, rlen: usize) -> crate::Result<Time>
    where
        R: SqlReadBytes + Unpin,
    {
        let val = match (n, rlen) {
            (0..=2, 3) => {
                let hi = src.read_u16_le().await? as u64;
                let lo = src.read_u8().await? as u64;

                hi | lo << 16
            }
            (3..=4, 4) => src.read_u32_le().await? as u64,
            (5..=7, 5) => {
                let hi = src.read_u32_le().await? as u64;
                let lo = src.read_u8().await? as u64;

                hi | lo << 32
            }
            _ => {
                return Err(crate::Error::Protocol(
                    format!("timen: invalid length {}", n).into(),
                ))
            }
        };

        Ok(Time {
            increments: val,
            scale: n as u8,
        })
    }
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl Encode<BytesMut> for Time {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        match self.len()? {
            3 => {
                assert_eq!(self.increments >> 24, 0);
                dst.put_u16_le(self.increments as u16);
                dst.put_u8((self.increments >> 16) as u8);
            }
            4 => {
                assert_eq!(self.increments >> 32, 0);
                dst.put_u32_le(self.increments as u32);
            }
            5 => {
                assert_eq!(self.increments >> 40, 0);
                dst.put_u32_le(self.increments as u32);
                dst.put_u8((self.increments >> 32) as u8);
            }
            _ => unreachable!(),
        }

        Ok(())
    }
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
/// A presentation of `datetime2` type in the server.
///
/// # Warning
///
/// It isn't recommended to use this type directly. For dealing with
/// `datetime2`, use the `time` feature of this crate and its `PrimitiveDateTime`
/// type.
pub struct DateTime2 {
    date: Date,
    time: Time,
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl DateTime2 {
    /// Construct a new `DateTime2` from the date and time components.
    pub fn new(date: Date, time: Time) -> Self {
        Self { date, time }
    }

    /// The date component.
    pub fn date(self) -> Date {
        self.date
    }

    /// The time component.
    pub fn time(self) -> Time {
        self.time
    }

    pub(crate) async fn decode<R>(src: &mut R, n: usize, rlen: usize) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let time = Time::decode(src, n, rlen).await?;

        let mut bytes = [0u8; 4];
        src.read_exact(&mut bytes[..3]).await?;
        let date = Date::new(LittleEndian::read_u32(&bytes));

        Ok(Self::new(date, time))
    }
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl Encode<BytesMut> for DateTime2 {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        self.time.encode(dst)?;

        let mut tmp = [0u8; 4];
        LittleEndian::write_u32(&mut tmp, self.date.days());
        assert_eq!(tmp[3], 0);
        dst.extend_from_slice(&tmp[0..3]);

        Ok(())
    }
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
/// A presentation of `datetimeoffset` type in the server.
///
/// # Warning
///
/// It isn't recommended to use this type directly. For dealing with
/// `datetimeoffset`, use the `time` feature of this crate and its `OffsetDateTime`
/// type with the correct timezone.
pub struct DateTimeOffset {
    datetime2: DateTime2,
    offset: i16,
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl DateTimeOffset {
    /// Construct a new `DateTimeOffset` from a `datetime2`, offset marking
    /// number of minutes from UTC.
    pub fn new(datetime2: DateTime2, offset: i16) -> Self {
        Self { datetime2, offset }
    }

    /// The date and time part.
    pub fn datetime2(self) -> DateTime2 {
        self.datetime2
    }

    /// Number of minutes from UTC.
    pub fn offset(self) -> i16 {
        self.offset
    }

    pub(crate) async fn decode<R>(src: &mut R, n: usize, rlen: u8) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let datetime2 = DateTime2::decode(src, n, rlen as usize).await?;
        let offset = src.read_i16_le().await?;

        Ok(Self { datetime2, offset })
    }
}

#[cfg(feature = "tds73")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "tds73")))]
impl Encode<BytesMut> for DateTimeOffset {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        self.datetime2.encode(dst)?;
        dst.put_i16_le(self.offset);

        Ok(())
    }
}

//! Representations of numeric types.

use super::codec::Encode;
use crate::{sql_read_bytes::SqlReadBytes, Error};
#[cfg(feature = "bigdecimal")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "bigdecimal")))]
pub use bigdecimal::{num_bigint::BigInt, BigDecimal};
use byteorder::{ByteOrder, LittleEndian};
use bytes::{BufMut, BytesMut};
#[cfg(feature = "rust_decimal")]
#[cfg_attr(feature = "docs", doc(cfg(feature = "rust_decimal")))]
pub use rust_decimal::Decimal;
use std::cmp::{Ordering, PartialEq};
use std::fmt::{self, Debug, Display, Formatter};

/// Represent a sql Decimal / Numeric type. It is stored in a i128 and has a
/// maximum precision of 38 decimals.
///
/// A recommended way of dealing with numeric values is by enabling the
/// `rust_decimal` feature and using its `Decimal` type instead.
#[derive(Copy, Clone)]
pub struct Numeric {
    value: i128,
    scale: u8,
}

impl Numeric {
    /// Creates a new Numeric value.
    ///
    /// # Panic
    /// It will panic if the scale exceed 37.
    pub fn new_with_scale(value: i128, scale: u8) -> Self {
        // scale cannot exceed 37 since a
        // max precision of 38 is possible here.
        assert!(scale < 38);

        Numeric { value, scale }
    }

    /// Extract the decimal part.
    pub fn dec_part(self) -> i128 {
        let scale = self.pow_scale();
        self.value - (self.value / scale) * scale
    }

    /// Extract the integer part.
    pub fn int_part(self) -> i128 {
        self.value / self.pow_scale()
    }

    #[inline]
    fn pow_scale(self) -> i128 {
        10i128.pow(self.scale as u32)
    }

    /// The scale (where is the decimal point) of the value.
    #[inline]
    pub fn scale(self) -> u8 {
        self.scale
    }

    /// The internal integer value
    #[inline]
    pub fn value(self) -> i128 {
        self.value
    }

    /// The precision of the `Number` as a number of digits.
    pub fn precision(self) -> u8 {
        let mut result = 0;
        let mut n = self.int_part();

        while n != 0 {
            n /= 10;
            result += 1;
        }

        if result == 0 {
            1 + self.scale()
        } else {
            result + self.scale()
        }
    }

    pub(crate) fn len(self) -> u8 {
        match self.precision() {
            1..=9 => 5,
            10..=19 => 9,
            20..=28 => 13,
            _ => 17,
        }
    }

    pub(crate) async fn decode<R>(src: &mut R, scale: u8) -> crate::Result<Option<Self>>
    where
        R: SqlReadBytes + Unpin,
    {
        fn decode_d128(buf: &[u8]) -> u128 {
            let low_part = LittleEndian::read_u64(&buf[0..]) as u128;

            if !buf[8..].iter().any(|x| *x != 0) {
                return low_part;
            }

            let high_part = match buf.len() {
                12 => LittleEndian::read_u32(&buf[8..]) as u128,
                16 => LittleEndian::read_u64(&buf[8..]) as u128,
                _ => unreachable!(),
            };

            // swap high&low for big endian
            #[cfg(target_endian = "big")]
            let (low_part, high_part) = (high_part, low_part);

            let high_part = high_part * (u64::max_value() as u128 + 1);
            low_part + high_part
        }

        let len = src.read_u8().await?;

        if len == 0 {
            Ok(None)
        } else {
            let sign = match src.read_u8().await? {
                0 => -1i128,
                1 => 1i128,
                _ => return Err(Error::Protocol("decimal: invalid sign".into())),
            };

            let value = match len {
                5 => src.read_u32_le().await? as i128 * sign,
                9 => src.read_u64_le().await? as i128 * sign,
                13 => {
                    let mut bytes = [0u8; 12]; //u96
                    for item in &mut bytes {
                        *item = src.read_u8().await?;
                    }
                    decode_d128(&bytes) as i128 * sign
                }
                17 => {
                    let mut bytes = [0u8; 16];
                    for item in &mut bytes {
                        *item = src.read_u8().await?;
                    }
                    decode_d128(&bytes) as i128 * sign
                }
                x => {
                    return Err(Error::Protocol(
                        format!("decimal/numeric: invalid length of {} received", x).into(),
                    ))
                }
            };

            Ok(Some(Numeric::new_with_scale(value, scale)))
        }
    }
}

impl Encode<BytesMut> for Numeric {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.put_u8(self.len());

        if self.value < 0 {
            dst.put_u8(0);
        } else {
            dst.put_u8(1);
        }

        let value = self.value().abs();

        match self.len() {
            5 => dst.put_u32_le(value as u32),
            9 => dst.put_u64_le(value as u64),
            13 => {
                dst.put_u64_le(value as u64);
                dst.put_u32_le((value >> 64) as u32)
            }
            _ => dst.put_u128_le(value as u128),
        }

        Ok(())
    }
}

impl Debug for Numeric {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), fmt::Error> {
        write!(
            f,
            "{}.{:0pad$}",
            self.int_part(),
            self.dec_part(),
            pad = self.scale as usize
        )
    }
}

impl Display for Numeric {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), fmt::Error> {
        write!(f, "{:?}", self)
    }
}

impl Eq for Numeric {}

impl From<Numeric> for f64 {
    fn from(n: Numeric) -> f64 {
        n.dec_part() as f64 / n.pow_scale() as f64 + n.int_part() as f64
    }
}

impl From<Numeric> for i128 {
    fn from(n: Numeric) -> i128 {
        n.int_part()
    }
}

impl From<Numeric> for u128 {
    fn from(n: Numeric) -> u128 {
        n.int_part() as u128
    }
}

impl PartialEq for Numeric {
    fn eq(&self, other: &Self) -> bool {
        match self.scale.cmp(&other.scale) {
            Ordering::Greater => {
                10i128.pow((self.scale - other.scale) as u32) * other.value == self.value
            }
            Ordering::Less => {
                10i128.pow((other.scale - self.scale) as u32) * self.value == other.value
            }
            Ordering::Equal => self.value == other.value,
        }
    }
}

#[cfg(feature = "rust_decimal")]
mod decimal {
    use super::{Decimal, Numeric};
    use crate::ColumnData;

    #[cfg(feature = "tds73")]
    from_sql!(Decimal: ColumnData::Numeric(ref num) => num.map(|num| {
        Decimal::from_i128_with_scale(
            num.value(),
            num.scale() as u32,
        )})
    );

    #[cfg(feature = "tds73")]
    to_sql!(self_,
            Decimal: (ColumnData::Numeric, {
                let unpacked = self_.unpack();

                let mut value = (((unpacked.hi as u128) << 64)
                                 + ((unpacked.mid as u128) << 32)
                                 + unpacked.lo as u128) as i128;

                if self_.is_sign_negative() {
                    value = -value;
                }

                Numeric::new_with_scale(value, self_.scale() as u8)
            });
    );
}

#[cfg(feature = "bigdecimal")]
mod bigdecimal_ {
    use super::{BigDecimal, BigInt, Numeric};
    use crate::ColumnData;
    use num_traits::ToPrimitive;
    use std::convert::TryFrom;

    #[cfg(feature = "tds73")]
    from_sql!(BigDecimal: ColumnData::Numeric(ref num) => num.map(|num| {
        let int = BigInt::from(num.value());

        BigDecimal::new(int, num.scale() as i64)
    }));

    #[cfg(feature = "tds73")]
    to_sql!(self_,
            BigDecimal: (ColumnData::Numeric, {
                let (int, exp) = self_.as_bigint_and_exponent();
                // SQL Server cannot store negative scales, so we have
                // to convert the number to the correct exponent
                // before storing.
                //
                // E.g. `Decimal(9, -3)` would be stored as
                // `Decimal(9000, 0)`.
                let (int, exp) = if exp < 0 {
                    self_.with_scale(0).into_bigint_and_exponent()
                } else {
                    (int, exp)
                };

                let value = int.to_i128().expect("Given BigDecimal overflowing the maximum accepted value.");

                let scale = u8::try_from(std::cmp::max(exp, 0))
                    .expect("Given BigDecimal exponent overflowing the maximum accepted scale (255).");

                Numeric::new_with_scale(value, scale)
            });
    );

    #[cfg(feature = "tds73")]
    into_sql!(self_,
            BigDecimal: (ColumnData::Numeric, {
                let (int, exp) = self_.as_bigint_and_exponent();
                // SQL Server cannot store negative scales, so we have
                // to convert the number to the correct exponent
                // before storing.
                //
                // E.g. `Decimal(9, -3)` would be stored as
                // `Decimal(9000, 0)`.
                let (int, exp) = if exp < 0 {
                    self_.with_scale(0).into_bigint_and_exponent()
                } else {
                    (int, exp)
                };
                let value = int.to_i128().expect("Given BigDecimal overflowing the maximum accepted value.");

                let scale = u8::try_from(std::cmp::max(exp, 0))
                    .expect("Given BigDecimal exponent overflowing the maximum accepted scale (255).");

                Numeric::new_with_scale(value, scale)
            });
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_eq() {
        assert_eq!(
            Numeric {
                value: 100501,
                scale: 2
            },
            Numeric {
                value: 1005010,
                scale: 3
            }
        );
        assert!(
            Numeric {
                value: 100501,
                scale: 2
            } != Numeric {
                value: 10050,
                scale: 1
            }
        );
    }

    #[test]
    fn numeric_to_f64() {
        assert_eq!(f64::from(Numeric::new_with_scale(57705, 2)), 577.05);
    }

    #[test]
    fn numeric_to_int_dec_part() {
        let n = Numeric::new_with_scale(57705, 2);
        assert_eq!(n.int_part(), 577);
        assert_eq!(n.dec_part(), 5);
    }

    #[test]
    fn calculates_precision_correctly() {
        let n = Numeric::new_with_scale(57705, 2);
        assert_eq!(5, n.precision());
    }

    #[test]
    #[cfg(feature = "bigdecimal")]
    fn no_overflowing_pow() {
        use crate::{ColumnData, ToSql};
        use bigdecimal::FromPrimitive;

        let dec = BigDecimal::new(BigInt::from_i8(1).unwrap(), -20);
        let res = dec.to_sql();

        assert_eq!(
            ColumnData::Numeric(Some(Numeric::new_with_scale(100000000000000000000i128, 0))),
            res
        );
    }
}

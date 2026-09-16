mod bytes_mut_with_data_columns;
mod into_row;
use crate::tds::codec::encode::Encode;
use crate::{tds::codec::ColumnData, BytesMutWithTypeInfo, SqlReadBytes, TokenType};
use bytes::BufMut;
pub(crate) use bytes_mut_with_data_columns::BytesMutWithDataColumns;
use futures_util::io::AsyncReadExt;
pub use into_row::IntoRow;

/// A row of data.
#[derive(Debug, Default, Clone)]
pub struct TokenRow<'a> {
    data: Vec<ColumnData<'a>>,
}

impl<'a> IntoIterator for TokenRow<'a> {
    type Item = ColumnData<'a>;
    type IntoIter = std::vec::IntoIter<Self::Item>;

    fn into_iter(self) -> Self::IntoIter {
        self.data.into_iter()
    }
}

impl<'a> Encode<BytesMutWithDataColumns<'a>> for TokenRow<'a> {
    fn encode(self, dst: &mut BytesMutWithDataColumns<'a>) -> crate::Result<()> {
        dst.put_u8(TokenType::Row as u8);

        if self.data.len() != dst.data_columns().len() {
            return Err(crate::Error::BulkInput(
                format!(
                    "Expecting {} columns but {} were given",
                    dst.data_columns().len(),
                    self.data.len()
                )
                .into(),
            ));
        }

        for (value, column) in self.data.into_iter().zip(dst.data_columns()) {
            let mut dst_ti = BytesMutWithTypeInfo::new(dst).with_type_info(&column.base.ty);
            value.encode(&mut dst_ti)?
        }

        Ok(())
    }
}

impl<'a> TokenRow<'a> {
    /// Creates a new empty row.
    pub const fn new() -> Self {
        Self { data: Vec::new() }
    }

    /// Creates a new empty row with allocated capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            data: Vec::with_capacity(capacity),
        }
    }

    /// Clears the row, removing all column values.
    ///
    /// Note that this method has no effect on the allocated capacity of the row.
    pub fn clear(&mut self) {
        self.data.clear();
    }

    /// The number of columns.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    /// Returns an iterator over column values.
    pub fn iter(&self) -> std::slice::Iter<'_, ColumnData<'a>> {
        self.data.iter()
    }

    /// True if row has no columns.
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Gets the columnar data with the given index. `None` if index out of
    /// bounds.
    pub fn get(&self, index: usize) -> Option<&ColumnData<'a>> {
        self.data.get(index)
    }

    /// Adds a new value to the row.
    pub fn push(&mut self, value: ColumnData<'a>) {
        self.data.push(value);
    }
}

impl TokenRow<'static> {
    /// Normal row. We'll read the metadata what we've cached and parse columns
    /// based on that.
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let col_meta = src.context().last_meta().unwrap();

        let mut row = Self {
            data: Vec::with_capacity(col_meta.columns.len()),
        };

        for column in col_meta.columns.iter() {
            let data = ColumnData::decode(src, &column.base.ty).await?;
            row.data.push(data);
        }

        Ok(row)
    }

    /// SQL Server has packed nulls on this row type. We'll read what columns
    /// are null from the bitmap.
    pub(crate) async fn decode_nbc<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let col_meta = src.context().last_meta().unwrap();
        let row_bitmap = RowBitmap::decode(src, col_meta.columns.len()).await?;

        let mut row = Self {
            data: Vec::with_capacity(col_meta.columns.len()),
        };

        for (i, column) in col_meta.columns.iter().enumerate() {
            let data = if row_bitmap.is_null(i) {
                column.base.null_value()
            } else {
                ColumnData::decode(src, &column.base.ty).await?
            };

            row.data.push(data);
        }

        Ok(row)
    }
}

/// A bitmap of null values in the row. Sometimes SQL Server decides to pack the
/// null values in the row, calling it the NBCROW. In this kind of tokens the row
/// itself skips the null columns completely, but they can be found from the bitmap
/// stored in the beginning of the token.
///
/// One byte can store eight bits of information. Bits with value of one being null.
///
/// If our row has eight columns, and our byte in bits is:
///
/// ```ignore
/// 1 0 0 1 0 1 0 0
/// ```
///
/// This would mean columns 0, 3 and 5 are null and should not be parsed at all.
/// For more than eight columns, more bits need to be reserved for the bitmap
/// (see the size calculation).
struct RowBitmap {
    data: Vec<u8>,
}

impl RowBitmap {
    /// Is the given column index null or not.
    #[inline]
    fn is_null(&self, i: usize) -> bool {
        let index = i / 8;
        let bit = i % 8;

        self.data[index] & (1 << bit) > 0
    }

    /// Decode the bitmap data from the beginning of the row. Only doable if the
    /// type is `NbcRowToken`.
    async fn decode<R>(src: &mut R, columns: usize) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let size = (columns + 8 - 1) / 8;
        let mut data = vec![0; size];
        src.read_exact(&mut data[0..size]).await?;

        Ok(Self { data })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BaseMetaDataColumn, ColumnFlag, FixedLenType, MetaDataColumn, TypeInfo};
    use bytes::BytesMut;

    #[tokio::test]
    async fn wrong_number_of_columns_will_fail() {
        let row = (true, 5).into_row();
        let columns = vec![MetaDataColumn {
            base: BaseMetaDataColumn {
                flags: ColumnFlag::Nullable.into(),
                ty: TypeInfo::FixedLen(FixedLenType::Bit),
            },
            col_name: Default::default(),
        }];
        let mut buf = BytesMut::new();
        let mut buf_with_columns = BytesMutWithDataColumns::new(&mut buf, &columns);

        row.encode(&mut buf_with_columns)
            .expect_err("wrong number of columns");
    }
}

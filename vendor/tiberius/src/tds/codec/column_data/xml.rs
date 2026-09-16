use std::{borrow::Cow, sync::Arc};

use crate::{
    sql_read_bytes::SqlReadBytes,
    xml::{XmlData, XmlSchema},
    ColumnData, VarLenType,
};

pub(crate) async fn decode<R>(
    src: &mut R,
    len: usize,
    schema: Option<Arc<XmlSchema>>,
) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let xml = super::string::decode(src, VarLenType::Xml, len, None)
        .await?
        .map(|data| {
            let mut data = XmlData::new(data);

            if let Some(schema) = schema {
                data.set_schema(schema);
            }

            Cow::Owned(data)
        });

    Ok(ColumnData::Xml(xml))
}

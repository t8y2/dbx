use super::*;
use crate::{sql_read_bytes::test_utils::IntoSqlReadBytes, SqlReadBytes};
use bytes::{BufMut, BytesMut};

fn message(width: usize) -> BytesMut {
    let text = "A\u{1f600}";
    let mut buf = BytesMut::new();
    buf.put_u16_le((10 + 2 * (text.encode_utf16().count() + 1) + width) as u16);
    buf.put_u32_le(195);
    buf.put_u8(10);
    buf.put_u8(15);
    buf.put_u16_le(text.encode_utf16().count() as u16);
    for c in text.encode_utf16() { buf.put_u16_le(c); }
    buf.put_u8(1); buf.put_u16_le('S' as u16);
    buf.put_u8(0);
    if width == 2 { buf.put_u16_le(321); } else { buf.put_u32_le(70000); }
    buf.put_u8(0xfd); // next token must stay untouched
    buf
}

#[tokio::test]
async fn legacy_info_and_error_preserve_next_token_before_loginack() {
    for width in [2, 4] {
        let mut info = message(width).into_sql_read_bytes();
        let decoded = TokenInfo::decode(&mut info).await.unwrap();
        assert_eq!(decoded.line, if width == 2 { 321 } else { 70000 });
        assert_eq!(decoded.message, "A\u{1f600}");
        assert_eq!(info.read_u8().await.unwrap(), 0xfd);
        let mut error = message(width).into_sql_read_bytes();
        let decoded = TokenError::decode(&mut error).await.unwrap();
        assert_eq!(decoded.code(), 195);
        assert_eq!(decoded.line(), if width == 2 { 321 } else { 70000 });
        assert_eq!(error.read_u8().await.unwrap(), 0xfd);
    }
}

#[tokio::test]
async fn legacy_message_rejects_invalid_length_without_consuming_line() {
    let mut buf = message(2);
    buf[0] = 1; buf[1] = 0;
    let mut reader = buf.into_sql_read_bytes();
    assert!(TokenInfo::decode(&mut reader).await.is_err());
    assert_eq!(reader.read_u16_le().await.unwrap(), 321);
}

#[tokio::test]
async fn legacy_done_and_column_width_follow_negotiated_context() {
    for version in [FeatureLevel::SqlServer2000Sp1, FeatureLevel::SqlServer2005, FeatureLevel::SqlServerN] {
        let mut done = BytesMut::new();
        done.put_u16_le(0x10); done.put_u16_le(0);
        if version < FeatureLevel::SqlServer2005 { done.put_u32_le(42); } else { done.put_u64_le(42); }
        done.put_u8(0xfd);
        let mut reader = done.into_sql_read_bytes();
        reader.context_mut().set_version(version);
        assert_eq!(TokenDone::decode(&mut reader).await.unwrap().rows(), 42);
        assert_eq!(reader.read_u8().await.unwrap(), 0xfd);
        let mut col = BytesMut::new();
        col.put_u16_le(1); // one column
        if version < FeatureLevel::SqlServer2005 { col.put_u16_le(0); } else { col.put_u32_le(0); }
        col.put_u16_le(0); col.put_u8(0x38); // fixed int
        col.put_u8(1); col.put_u16_le('v' as u16); col.put_u8(0xd1);
        let mut reader = col.into_sql_read_bytes();
        reader.context_mut().set_version(version);
        let columns = TokenColMetaData::decode(&mut reader).await.unwrap();
        assert_eq!(columns.columns[0].col_name, "v");
        assert_eq!(reader.read_u8().await.unwrap(), 0xd1);
    }
}

#[test]
fn legacy_batch_and_rpc_omit_only_tds72_headers() {
    let descriptor = [9u8; 8];
    let mut legacy = BytesMut::new();
    let mut modern = BytesMut::new();
    BatchRequest::new("SELECT 1", descriptor).with_tds_version(FeatureLevel::SqlServer2000Sp1).encode(&mut legacy).unwrap();
    BatchRequest::new("SELECT 1", descriptor).with_tds_version(FeatureLevel::SqlServer2005).encode(&mut modern).unwrap();
    assert_eq!(legacy.as_ref(), "SELECT 1".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
    assert_eq!(modern.len(), legacy.len() + ALL_HEADERS_LEN_TX);
    assert_eq!(&modern[10..18], &descriptor);
    assert_eq!(&modern[ALL_HEADERS_LEN_TX..], legacy.as_ref());
    legacy.clear(); modern.clear();
    TokenRpcRequest::new(RpcProcId::ExecuteSQL, vec![], descriptor).with_tds_version(FeatureLevel::SqlServer2000Sp1).encode(&mut legacy).unwrap();
    TokenRpcRequest::new(RpcProcId::ExecuteSQL, vec![], descriptor).with_tds_version(FeatureLevel::SqlServerN).encode(&mut modern).unwrap();
    assert_eq!(legacy.as_ref(), &[0xff, 0xff, 10, 0, 0, 0]);
    assert_eq!(&modern[10..18], &descriptor);
    assert_eq!(&modern[ALL_HEADERS_LEN_TX..], legacy.as_ref());
}
#[tokio::test]
async fn legacy_lob_table_names_preserve_next_row_token() {
    for version in [FeatureLevel::SqlServer2000Sp1, FeatureLevel::SqlServerN] {
        for ty in [0x23, 0x63, 0x22] {
            let mut col = BytesMut::new(); col.put_u16_le(1);
            if version < FeatureLevel::SqlServer2005 { col.put_u16_le(0); } else { col.put_u32_le(0); }
            col.put_u16_le(0); col.put_u8(ty); col.put_u32_le(100);
            if ty != 0x22 { col.extend_from_slice(&[0x09, 0x04, 0, 0, 0]); }
            let names: &[&str] = if version < FeatureLevel::SqlServer2005 { &["dbo.test"] } else { &["db", "dbo", "test"] };
            if version >= FeatureLevel::SqlServer2005 { col.put_u8(names.len() as u8); }
            for name in names {
                col.put_u16_le(name.encode_utf16().count() as u16);
                for unit in name.encode_utf16() { col.put_u16_le(unit); }
            }
            col.put_u8(1); col.put_u16_le('v' as u16); col.put_u8(0xd1);
            let mut reader = col.into_sql_read_bytes(); reader.context_mut().set_version(version);
            assert_eq!(TokenColMetaData::decode(&mut reader).await.unwrap().columns[0].col_name, "v");
            assert_eq!(reader.read_u8().await.unwrap(), 0xd1);
        }
    }
}

#[test]
fn legacy_rpc_lob_and_unicode_encodings_match_declared_types() {
    use std::borrow::Cow;
    use enumflags2::BitFlags;
    let legacy = FeatureLevel::SqlServer2000Sp1;
    let modern = FeatureLevel::SqlServerN;
    let encode = |value, version| {
        let mut dst = BytesMut::new();
        TokenRpcRequest::new(RpcProcId::ExecuteSQL, vec![RpcParam { name: Cow::Borrowed(""), flags: BitFlags::empty(), value }], [0;8])
            .with_tds_version(version).encode(&mut dst).unwrap();
        let offset = if version < FeatureLevel::SqlServer2005 { 6 } else { 6 + ALL_HEADERS_LEN_TX };
        dst[offset + 2..].to_vec() // skip empty name + flags
    };
    let unicode = ColumnData::String(Some("\u{4e2d}".repeat(1400).into()));
    assert_eq!(unicode.type_name_for_version(legacy), "nvarchar(4000)");
    assert_eq!(encode(unicode, legacy)[0], 0xe7);
    let large = ColumnData::String(Some("x".repeat(4001).into()));
    assert_eq!(large.type_name_for_version(legacy), "ntext");
    assert_eq!(large.type_name_for_version(modern), "nvarchar(max)");
    let old = encode(large.clone(), legacy); let new = encode(large, modern);
    assert_eq!(old[0], 0x63); assert_eq!(&old[10..14], &8002u32.to_le_bytes());
    assert_eq!(new[0], 0xe7); assert_eq!(&new[1..3], &[0xff,0xff]);
    let binary = ColumnData::Binary(Some(vec![0x5a;8001].into()));
    assert_eq!(binary.type_name_for_version(legacy), "image");
    assert_eq!(encode(binary, legacy)[0], 0x22);
    assert_eq!(ColumnData::Binary(None).type_name_for_version(legacy), "varbinary(8000)");
}

#[test]
fn legacy_attention_is_an_empty_end_of_message_packet() {
    let mut dst = BytesMut::new();
    PacketHeader::attention(3).encode(&mut dst).unwrap();
    assert_eq!(dst.as_ref(), &[6, 1, 0, 8, 0, 0, 3, 0]);
}
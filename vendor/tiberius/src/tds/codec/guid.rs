/// UUIDs use network byte order (big endian) for the first 3 groups,
/// while GUIDs use native byte order (little endian).
///
/// https://github.com/microsoft/mssql-jdbc/blob/bec39dbba9544aef5f5f6a5495d5acf533efd6da/src/main/java/com/microsoft/sqlserver/jdbc/Util.java#L708-L730
pub(crate) fn reorder_bytes(bytes: &mut uuid::Bytes) {
    bytes.swap(0, 3);
    bytes.swap(1, 2);
    bytes.swap(4, 5);
    bytes.swap(6, 7);
}

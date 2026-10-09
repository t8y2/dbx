package com.oceanbase.jdbc;

/** Connector/J 2.4.18 payload accounting only; never reads or exposes LOB bytes. */
public final class DbxLobResourceBytes {
    private DbxLobResourceBytes() {}

    public static long retainedBytes(Object value) {
        if (!(value instanceof Lob lob)) return -1;
        long bytes = 256; // conservative entry/locator metadata allowance
        if (lob.data != null) bytes += lob.data.length;
        if (lob.charData != null) bytes += 2L * lob.charData.length();
        ObLobLocator locator = lob.getLocator();
        if (locator != null) {
            if (locator.binaryData != null) bytes += locator.binaryData.length;
            if (locator instanceof ObLobLocatorV1 v1) {
                if (v1.rowId != null) bytes += v1.rowId.length;
                if (v1.tableId != null) bytes += v1.tableId.length;
            }
        }
        return bytes;
    }
}

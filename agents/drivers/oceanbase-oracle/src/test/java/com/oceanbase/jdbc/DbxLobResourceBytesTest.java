package com.oceanbase.jdbc;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class DbxLobResourceBytesTest {
    @Test
    void countsExistingDriverPayloadAndLocatorWithoutReadingTheServer() {
        Clob clob = new Clob("中文🙂".repeat(100), null);
        ObLobLocatorV1 locator = new ObLobLocatorV1();
        locator.binaryData = new byte[1200];
        locator.rowId = new byte[20];
        locator.tableId = new byte[8];
        clob.locator = locator;
        assertEquals(256 + 800 + 1200 + 20 + 8, DbxLobResourceBytes.retainedBytes(clob));
        locator.binaryData = new byte[96];
        clob.charData = null;
        clob.data = null;
        locator.payloadSize = 1024L * 1024 * 1024; // out-row length is not retained payload
        assertEquals(256 + 96 + 20 + 8, DbxLobResourceBytes.retainedBytes(clob));
        assertEquals(-1, DbxLobResourceBytes.retainedBytes(new Object()));
    }
}

package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;

import javax.sql.rowset.serial.SerialClob;
import java.io.IOException;
import java.io.Reader;
import java.sql.Clob;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugOutputTest {
    @Test
    void freezesAnonymousRootTokenAndActualSourceCoordinates() {
        String source = "DECLARE V NUMBER := 1;\r\nBEGIN\r\n NULL;\r\nEND;";
        PlDebugOutput.Block block = PlDebugOutput.wrap(source);
        assertEquals(source, block.source());
        assertTrue(block.privateNames().contains(block.rootTokenName()));
        assertTrue(block.sql().startsWith("DECLARE\n  " + block.rootTokenName() + " CONSTANT VARCHAR2(32) := '" + block.rootToken() + "';\n"));
        assertEquals(source, block.sql().substring(block.sql().indexOf(source), block.sql().indexOf(source) + source.length()));
        assertEquals(block.sourceLineOffset(), block.sql().substring(0, block.sql().indexOf(source)).chars().filter(c -> c == '\n').count());
    }

    @Test
    void keepsEmptyLinesMaxLinesUnicodeAndBatchBoundariesExactly() throws Exception {
        String expected = "first\n\n" + "x".repeat(32767) + "\n" + "汉|*\"\\\u001f😀\n".repeat(12000);
        PlDebugOutput.Text output = PlDebugOutput.readText(new SerialClob(expected.toCharArray()), null, PlDebugOutput.MAX_CHARS);
        assertEquals(expected, output.text());
        assertTrue(output.complete());
        StringBuilder result = new StringBuilder();
        int cursor = 0;
        while (cursor < expected.length()) {
            PlDebugOutput.Page page = PlDebugOutput.page(output, cursor, 32000);
            assertEquals(page, PlDebugOutput.page(output, cursor, 32000), "a repeated read only replays Agent cache");
            result.append(page.text());
            assertTrue(page.nextOffset() > cursor);
            cursor = page.nextOffset();
        }
        assertEquals(expected, result.toString());
        assertEquals("", PlDebugOutput.page(output, cursor, 32000).text());
    }

    @Test
    void retainsConfirmedPrefixAndReportsATransferFailure() {
        Reader broken = new Reader() {
            boolean sent;
            public int read(char[] chars, int offset, int length) throws IOException {
                if (sent) throw new IOException("test transport loss");
                sent = true;
                "prefix\n\n".getChars(0, 8, chars, offset);
                return 8;
            }
            public void close() {}
        };
        Clob clob = proxy(Clob.class, (method, args) -> method.getName().equals("getCharacterStream")
            ? broken : empty(method.getReturnType()));
        PlDebugOutput.Text output = PlDebugOutput.readText(clob, null, PlDebugOutput.MAX_CHARS);
        assertEquals("prefix\n\n", output.text());
        assertFalse(output.complete());
        assertNotNull(output.error());
        assertEquals("prefix\n\n", PlDebugOutput.page(output, 0, 32000).text());
    }

    @Test
    void makesCapacityAndUnicodeCursorLimitsExplicit() throws Exception {
        PlDebugOutput.Text truncated = PlDebugOutput.readText(new SerialClob("abc😀tail".toCharArray()), null, 4);
        assertEquals("abc", truncated.text());
        assertTrue(truncated.truncated());
        assertFalse(truncated.complete());
        PlDebugOutput.Text text = new PlDebugOutput.Text("abc😀tail", true, false, null);
        assertEquals("abc", PlDebugOutput.page(text, 0, 4).text());
        assertThrows(IllegalArgumentException.class, () -> PlDebugOutput.page(text, 4, 2));
        assertEquals("😀", PlDebugOutput.page(text, 3, 2).text());
        assertThrows(IllegalArgumentException.class, () -> PlDebugOutput.page(text, 0, 1));
        assertThrows(IllegalArgumentException.class, () -> PlDebugOutput.page(text, 100, 2));
    }

    @Test
    void mapsUserSourceWithoutEditingItAndKeepsCleanupBusinessFree() {
        String source = "DECLARE\n  n NUMBER := 1;\nBEGIN\n  n := n + 1;\nEND;";
        PlDebugOutput.Block block = PlDebugOutput.wrap(source);
        String[] lines = block.sql().split("\n");
        assertEquals("DECLARE", lines[block.sourceLineOffset()]);
        assertTrue(block.sql().contains(source));
        assertFalse(PlDebugOutput.cleanupSql().contains("n := n + 1"));
        PlDebugNativeTest.assertNoHelperDdl(java.util.List.of(block.sql(), PlDebugOutput.cleanupSql()));
    }

    @Test
    void excludesOnlyGeneratedPrivateNamesAndKeepsUserNamesThatResembleTheOldWrapper() {
        String source = "DECLARE dbx_pd_error NUMBER := 7; BEGIN NULL; END;";
        PlDebugOutput.Block block = PlDebugOutput.wrap(source);
        PlDebugNative.Value user = new PlDebugNative.Value("DBX_PD_ERROR", null, "value", "7", "7", null);
        PlDebugNative.Value internal = new PlDebugNative.Value(block.privateNames().iterator().next(), null, "null", null, "Null", null);
        assertEquals(java.util.List.of(user), block.userValues(java.util.List.of(internal, user)));
        assertTrue(block.sql().contains(source));
        assertTrue(block.privateNames().stream().allMatch(name -> name.length() <= 30));
        assertFalse(block.privateNames().contains("DBX_PD_ERROR"));
    }
}

package com.dbx.agent.firebird;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LegacyTextDecoderTest {
    private static final Charset GBK = Charset.forName("GBK");

    @Test
    void recoversUserTestRowAndColumnComments() {
        assertEquals("草稿", LegacyTextDecoder.decode("²Ý¸å", GBK));
        assertEquals("明细状态", LegacyTextDecoder.decode("Ã÷Ï¸×´Ì¬", GBK));
        assertEquals("子流水", LegacyTextDecoder.decode("×ÓÁ÷Ë®", GBK));
    }

    @Test
    void preservesDefaultUnicodeAsciiNullAndMalformedData() {
        assertEquals("²Ý¸å", LegacyTextDecoder.decode("²Ý¸å", null));
        assertEquals("中文😀", LegacyTextDecoder.decode("中文😀", GBK));
        assertEquals("bad�", LegacyTextDecoder.decode("bad�", GBK));
        assertEquals("id", LegacyTextDecoder.decode("id", GBK));
        assertNull(LegacyTextDecoder.decode(null, GBK));
        assertEquals("é", LegacyTextDecoder.decode("é", GBK)); // Incomplete GBK sequence.
    }

    @Test
    void supportsExplicitBig5AndGb18030() {
        for (String name : new String[] {"Big5", "GB18030"}) {
            Charset charset = Charset.forName(name);
            String latin1 = new String("中文".getBytes(charset), StandardCharsets.ISO_8859_1);
            assertEquals("中文", LegacyTextDecoder.decode(latin1, charset));
        }
    }

    @Test
    void separatesDbxReadOptionFromJdbcPropertiesIncludingFullUrls() {
        String url = "jdbc:firebirdsql://localhost:3050/C:/test.fdb?charSet=ISO8859_1&dataCharset=GBK&sqlDialect=3";
        assertEquals(GBK, LegacyTextDecoder.charsetFromUrl(url));
        assertEquals("jdbc:firebirdsql://localhost:3050/C:/test.fdb?charSet=ISO8859_1&sqlDialect=3", LegacyTextDecoder.jdbcUrl(url));
        assertEquals(GBK, LegacyTextDecoder.charsetFromUrl("jdbc:firebirdsql:x?DATACHARSET=%47%42%4b"));
        assertEquals("jdbc:firebirdsql:x", LegacyTextDecoder.jdbcUrl("jdbc:firebirdsql:x?dataCharset=GBK"));
        assertNull(LegacyTextDecoder.charsetFromUrl("jdbc:firebirdsql:x?dataCharset="));
        assertEquals("jdbc:firebirdsql:x?charSet=GBK;sqlDialect=3", LegacyTextDecoder.jdbcUrl("jdbc:firebirdsql:x?charSet=GBK;sqlDialect=3"));
        assertThrows(IllegalArgumentException.class, () -> LegacyTextDecoder.charsetFromUrl("jdbc:firebirdsql:x?dataCharset=not-a-charset"));
    }
}

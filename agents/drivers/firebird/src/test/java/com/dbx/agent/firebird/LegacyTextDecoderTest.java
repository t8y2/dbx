package com.dbx.agent.firebird;

import com.dbx.agent.ConnectParams;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Properties;
import org.firebirdsql.encodings.EncodingDefinition;
import org.firebirdsql.encodings.EncodingFactory;
import org.firebirdsql.jdbc.FBDriver;
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
    void encodesSqlInTheDataCharsetWhileKeepingTheServerLatin1Charset() throws Exception {
        for (String charset : List.of("GBK", "GB18030", "Big5")) {
            for (String params : List.of("charSet=ISO8859_1", "local_encoding=ISO-8859-1",
                "encoding=ISO8859_1", "lc_ctype=ISO8859_1&charset=ISO8859_1")) {
                Properties properties = new Properties();
                properties.putAll(FBDriver.normalizeProperties("jdbc:firebirdsql:x?" + params, null));
                LegacyTextDecoder.configureWrites(properties, Charset.forName(charset));
                EncodingDefinition encoding = EncodingFactory.getPlatformDefault().getEncodingDefinition(
                    properties.getProperty("encoding"), properties.getProperty("charSet"));
                assertEquals("ISO8859_1", encoding.getFirebirdEncodingName());
                assertArrayEquals("中文".getBytes(Charset.forName(charset)),
                    encoding.getEncoding().encodeToCharset("中文"));
                String stored = new String(encoding.getEncoding().encodeToCharset("中文"), StandardCharsets.ISO_8859_1);
                assertEquals("中文", LegacyTextDecoder.decode(stored, Charset.forName(charset)));
            }
        }
    }

    @Test
    void leavesOtherConnectionCharsetsUnchanged() throws Exception {
        for (String params : List.of("", "charSet=UTF8", "charSet=GBK", "encoding=NONE&charSet=ISO8859_1")) {
            Properties properties = new Properties();
            properties.putAll(FBDriver.normalizeProperties("jdbc:firebirdsql:x?" + params, null));
            Properties original = new Properties();
            original.putAll(properties);
            LegacyTextDecoder.configureWrites(properties, GBK);
            assertEquals(original, properties);
        }
    }

    @Test
    void sharedConnectionPathRetainsNormalizedUrlPropertiesAndCredentials() throws Exception {
        FirebirdAgent agent = new FirebirdAgent();
        for (String options : List.of("charSet=ISO8859_1", "local_encoding=ISO-8859-1",
            "lc_ctype=ISO8859_1&charset=ISO8859_1")) {
            for (boolean fullUrl : List.of(false, true)) {
                String query = options + "&dataCharset=GBK&sqlDialect=3&connectTimeout=7";
                ConnectParams params = new ConnectParams("localhost", 3050, "test.fdb", "test-user", "test-password",
                    fullUrl ? "" : query,
                    fullUrl ? "jdbc:firebirdsql://localhost:3050/test.fdb?" + query : "", false);
                var properties = FBDriver.normalizeProperties(agent.buildJdbcUrl(params), agent.buildConnectionProperties(params));
                assertEquals("ISO8859_1", properties.get("encoding"));
                assertEquals("GBK", properties.get("charSet"));
                assertEquals("3", properties.get("sqlDialect"));
                assertEquals("7", properties.get("connectTimeout"));
                assertEquals("test-user", properties.get("user"));
                assertEquals("test-password", properties.get("password"));
                assertFalse(properties.containsKey("dataCharset"));
            }
        }
    }

    @Test
    void emptyDataCharsetPreservesConnectionOptions() throws Exception {
        FirebirdAgent agent = new FirebirdAgent();
        ConnectParams params = new ConnectParams("localhost", 3050, "test.fdb", "test-user", "test-password",
            "charSet=ISO8859_1&dataCharset=&sqlDialect=3", "", false);
        assertEquals("jdbc:firebirdsql://localhost:3050/test.fdb?charSet=ISO8859_1&sqlDialect=3", agent.buildJdbcUrl(params));
        var properties = FBDriver.normalizeProperties(agent.buildJdbcUrl(params), agent.buildConnectionProperties(params));
        assertEquals("ISO8859_1", properties.get("charSet"));
        assertEquals("3", properties.get("sqlDialect"));
    }

    @Test
    void separatesDbxReadOptionFromJdbcPropertiesIncludingFullUrls() {
        String url = "jdbc:firebirdsql://localhost:3050/C:/test.fdb?charSet=ISO8859_1&dataCharset=GBK&sqlDialect=3";
        assertEquals(GBK, LegacyTextDecoder.charsetFromUrl(url));
        assertEquals("jdbc:firebirdsql://localhost:3050/C:/test.fdb", LegacyTextDecoder.jdbcUrl(url));
        assertEquals("jdbc:firebirdsql://localhost:3050/C:/test.fdb?charSet=ISO8859_1&sqlDialect=3",
            LegacyTextDecoder.jdbcUrlWithoutDataCharset(url));
        assertEquals(GBK, LegacyTextDecoder.charsetFromUrl("jdbc:firebirdsql:x?DATACHARSET=%47%42%4b"));
        assertEquals("jdbc:firebirdsql:x", LegacyTextDecoder.jdbcUrl("jdbc:firebirdsql:x?dataCharset=GBK"));
        assertNull(LegacyTextDecoder.charsetFromUrl("jdbc:firebirdsql:x?dataCharset="));
        assertEquals("jdbc:firebirdsql:x?charSet=GBK;sqlDialect=3", LegacyTextDecoder.jdbcUrl("jdbc:firebirdsql:x?charSet=GBK;sqlDialect=3"));
        assertThrows(IllegalArgumentException.class, () -> LegacyTextDecoder.charsetFromUrl("jdbc:firebirdsql:x?dataCharset=not-a-charset"));
    }
}

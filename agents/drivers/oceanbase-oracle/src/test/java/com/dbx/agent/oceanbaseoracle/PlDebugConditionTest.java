package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.sql.SQLException;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugConditionTest {
    @Test
    void rulesRequireExactNonnegativeCountsAndBoundedUtf8Text() {
        assertEquals(2, PlDebugRules.parse(java.util.Map.of("ignoreCount", 2.0)).ignoreCount());
        for (Object count : new Object[] {-1, 0.5, "2", Double.POSITIVE_INFINITY}) {
            assertThrows(IllegalArgumentException.class, () -> PlDebugRules.parse(java.util.Map.of("ignoreCount", count)));
        }
        assertThrows(IllegalArgumentException.class, () -> PlDebugRules.parse(java.util.Map.of("message", "中".repeat(1400))));
        assertThrows(IllegalArgumentException.class, () -> PlDebugRules.parse(java.util.Map.of("condition", 1)));
    }

    private static PlDebugNative.Value value(String state, String text) {
        return new PlDebugNative.Value("N", "NUMBER", state, text, text, null);
    }

    @Test
    void comparesExactLargeNumbersAndBoundedExponents() throws Exception {
        assertEquals("true", PlDebugCondition.evaluate("N > 9007199254740992", name -> value("value", "9007199254740993")).state());
        assertEquals("false", PlDebugCondition.evaluate("N == 9007199254740992", name -> value("value", "9007199254740993")).state());
        assertEquals("true", PlDebugCondition.evaluate("P.N <= -0.5e-4096", name -> {
            assertEquals("P.N", name);
            return value("value", "-0.5e-4096");
        }).state());
        assertEquals("true", PlDebugCondition.evaluate("N == 1e4096", name -> value("value", "10e4095")).state());
        for (String literal : new String[] {"1e4097", "1e-4097", "NaN", "Infinity", "1e999999999999999999"}) {
            assertEquals("unparseable", PlDebugCondition.evaluate("N == " + literal, name -> {
                fail("Unsupported literals must not read the debuggee");
                return null;
            }).state());
        }
    }

    @Test
    void handlesNullAndEscapedStringsWithoutExecutingExpressions() throws Exception {
        assertEquals("true", PlDebugCondition.evaluate("N == NULL", name -> value("null", null)).state());
        assertEquals("true", PlDebugCondition.evaluate("N != NULL", name -> value("value", "NULL")).state());
        assertEquals("true", PlDebugCondition.evaluate("N == 'it''s 中文'", name -> value("value", "it's 中文")).state());
        assertEquals("true", PlDebugCondition.evaluate("N == ''", name -> value("empty", "")).state());
        assertEquals("unparseable", PlDebugCondition.evaluate("N > NULL", name -> value("null", null)).state());
        assertEquals("unparseable", PlDebugCondition.evaluate("N > 'text'", name -> value("value", "text")).state());
        assertEquals("unparseable", PlDebugCondition.evaluate("N == 1", name -> value("unavailable", null)).state());
        AtomicInteger reads = new AtomicInteger();
        for (String condition : new String[] {"F() == 1", "N := 1", "N == 1 OR 1=1", "N == '" + "中".repeat(1400) + "'"}) {
            assertEquals("unparseable", PlDebugCondition.evaluate(condition, name -> { reads.incrementAndGet(); return value("value", "1"); }).state());
        }
        assertEquals(0, reads.get());
        SQLException lost = new SQLException("lost", "08006");
        assertSame(lost, assertThrows(SQLException.class, () -> PlDebugCondition.evaluate("N == 1", name -> { throw lost; })));
    }
}

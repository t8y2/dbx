package com.dbx.agent.oceanbaseoracle;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.Map;

record PlDebugRules(long ignoreCount, String condition, String message) {
    static final PlDebugRules EMPTY = new PlDebugRules(0, "", "");

    static PlDebugRules parse(Map<String, Object> input) {
        if (input == null) return EMPTY;
        long ignore = 0;
        if (input.containsKey("ignoreCount")) {
            Object value = input.get("ignoreCount");
            if (!(value instanceof Number)) throw new IllegalArgumentException("ignoreCount must be a nonnegative integer");
            try { ignore = new BigDecimal(value.toString()).longValueExact(); }
            catch (ArithmeticException | NumberFormatException error) { throw new IllegalArgumentException("ignoreCount must be a nonnegative integer"); }
            if (ignore < 0) throw new IllegalArgumentException("ignoreCount must be a nonnegative integer");
        }
        return new PlDebugRules(ignore, text(input, "condition"), text(input, "message"));
    }

    private static String text(Map<String, Object> input, String name) {
        if (!input.containsKey(name)) return "";
        Object value = input.get(name);
        if (!(value instanceof String text) || text.getBytes(StandardCharsets.UTF_8).length > 4096) {
            throw new IllegalArgumentException(name + " must be a string of at most 4096 bytes");
        }
        return text;
    }
}

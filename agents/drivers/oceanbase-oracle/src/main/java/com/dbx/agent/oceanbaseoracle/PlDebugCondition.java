package com.dbx.agent.oceanbaseoracle;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.regex.Pattern;

final class PlDebugCondition {
    private static final Pattern EXPRESSION = Pattern.compile("^([A-Za-z_][\\w$#]*(?:\\.[\\w$#]+)?)\\s*(==|!=|>=|<=|>|<)\\s*(.+)$");
    private static final Pattern NUMBER = Pattern.compile("^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE]([+-]?\\d+))?$");
    private static final Pattern STRING = Pattern.compile("^'(?:[^']|'')*'$");

    interface Reader { PlDebugNative.Value read(String name) throws Exception; }
    record Verdict(String state, String reason) {}

    private static Verdict unknown(String reason) { return new Verdict("unparseable", reason); }

    private static BigDecimal numeric(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        var match = NUMBER.matcher(text);
        if (!match.matches()) return null;
        try {
            if (match.group(1) != null) {
                int exponent = Integer.parseInt(match.group(1));
                if (exponent < -4096 || exponent > 4096) return null;
            }
            return new BigDecimal(text);
        } catch (NumberFormatException error) { return null; }
    }

    // The author's finite Store evaluator, shared with the Go adapter's contract.
    static Verdict evaluate(String expression, Reader reader) throws Exception {
        if (expression.getBytes(StandardCharsets.UTF_8).length > 4096) return unknown("condition exceeds the 4096-byte limit");
        var match = EXPRESSION.matcher(expression.trim());
        if (!match.matches()) return unknown("expected variable operator literal");
        String name = match.group(1);
        String operator = match.group(2);
        String literal = match.group(3).trim();
        boolean nil = "NULL".equalsIgnoreCase(literal);
        BigDecimal number = numeric(literal);
        boolean text = STRING.matcher(literal).matches();
        if (!nil && number == null && !text) return unknown("unsupported literal or numeric exponent outside -4096..4096");
        PlDebugNative.Value value = reader.read(name);
        if (!Set.of("value", "empty", "null").contains(value.state())) return unknown("variable " + name + " could not be read in the stopped frame");
        int comparison;
        if (nil) {
            if (!operator.equals("==") && !operator.equals("!=")) return unknown("NULL supports only == and !=");
            comparison = "null".equals(value.state()) ? 0 : 1;
        } else {
            if ("null".equals(value.state()) || value.value() == null) return unknown("variable " + name + " is NULL or has no scalar payload");
            if (number != null) {
                BigDecimal actual = numeric(value.value());
                if (actual == null) return unknown("variable " + name + " is not an exact numeric scalar");
                comparison = actual.compareTo(number);
            } else {
                if (!operator.equals("==") && !operator.equals("!=")) return unknown("string literals support only == and !=");
                comparison = value.value().compareTo(literal.substring(1, literal.length() - 1).replace("''", "'"));
            }
        }
        boolean matched = switch (operator) {
            case "==" -> comparison == 0;
            case "!=" -> comparison != 0;
            case ">" -> comparison > 0;
            case "<" -> comparison < 0;
            case ">=" -> comparison >= 0;
            case "<=" -> comparison <= 0;
            default -> throw new IllegalStateException("Unexpected condition operator");
        };
        return new Verdict(matched ? "true" : "false", null);
    }
}

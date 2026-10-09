package com.dbx.agent.oceanbaseoracle;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/** Preserve dictionary source, qualifying only the trigger declaration and its table reference. */
final class OceanBaseTriggerDdl {
    private static final Pattern TOKEN = Pattern.compile(
        "(?s)\\s+|--[^\\r\\n]*|/\\*.*?\\*/|\"(?:\"\"|[^\"])*\"|'(?:''|[^'])*'|[\\p{L}\\p{N}_$#]+|.");

    private OceanBaseTriggerDdl() {}

    static String render(String source, String owner, String name, String tableOwner, String table, String status)
        throws SQLException {
        if (source == null || source.isBlank()) throw new SQLException("Trigger source is empty or not visible: " + name);
        String state = status == null ? "" : status.toUpperCase(Locale.ROOT);
        String action = switch (state) {
            case "ENABLE", "ENABLED" -> "ENABLE";
            case "DISABLE", "DISABLED" -> "DISABLE";
            default -> throw new SQLException("Trigger enable status is unavailable: " + name);
        };
        List<Token> tokens = new ArrayList<>();
        var matcher = TOKEN.matcher(source);
        while (matcher.find()) {
            String text = matcher.group();
            if (!text.isBlank() && !text.startsWith("--") && !text.startsWith("/*")) {
                tokens.add(new Token(text, matcher.start(), matcher.end()));
            }
        }
        int declaration = 1;
        if (tokens.isEmpty() || !tokens.get(0).is("CREATE")) throw new SQLException("Incomplete CREATE TRIGGER source: " + name);
        if (tokens.size() > 2 && tokens.get(1).is("OR") && tokens.get(2).is("REPLACE")) declaration = 3;
        if (declaration >= tokens.size() || !tokens.get(declaration).is("TRIGGER")) {
            throw new SQLException("Unsupported trigger declaration: " + name);
        }
        Reference trigger = reference(tokens, declaration + 1, owner, name);
        int on = trigger.next;
        while (on < tokens.size() && !tokens.get(on).is("ON")) {
            if (tokens.get(on).is("BEGIN") || tokens.get(on).is("DECLARE")) break;
            on++;
        }
        if (on >= tokens.size() || !tokens.get(on).is("ON")) throw new SQLException("Trigger table reference is unavailable: " + name);
        Reference relation = reference(tokens, on + 1, tableOwner, table);
        String qualified = source.substring(0, trigger.start) + quote(owner) + "." + quote(name)
            + source.substring(trigger.end, relation.start) + quote(tableOwner) + "." + quote(table)
            + source.substring(relation.end);
        qualified = qualified.strip();
        // SQL*Plus block delimiters stay outside the PL/SQL source; never split its internal semicolons.
        if (qualified.endsWith("\n/")) qualified = qualified.substring(0, qualified.length() - 1).stripTrailing();
        if (!qualified.endsWith(";")) qualified += "\n;";
        return qualified + "\n/\nALTER TRIGGER " + quote(owner) + "." + quote(name) + " " + action + ";";
    }

    private static Reference reference(List<Token> tokens, int index, String owner, String name) throws SQLException {
        if (index >= tokens.size()) throw new SQLException("Missing trigger identifier: " + name);
        Token first = tokens.get(index);
        Token last = first;
        int next = index + 1;
        if (next < tokens.size() && tokens.get(next).is(".")) {
            if (++next >= tokens.size() || !first.identifier().equals(owner)) throw new SQLException("Trigger schema does not match dictionary: " + name);
            last = tokens.get(next++);
        }
        if (!last.identifier().equals(name)) throw new SQLException("Trigger identifier does not match dictionary: " + name);
        return new Reference(first.start, last.end, next);
    }

    private static String quote(String value) { return "\"" + value.replace("\"", "\"\"") + "\""; }

    private record Reference(int start, int end, int next) {}
    private record Token(String text, int start, int end) {
        boolean is(String value) { return text.equalsIgnoreCase(value); }
        String identifier() {
            return text.startsWith("\"") ? text.substring(1, text.length() - 1).replace("\"\"", "\"") : text.toUpperCase(Locale.ROOT);
        }
    }
}

package com.dbx.agent;

import java.util.Locale;
import java.util.regex.Pattern;

final class JdbcConnectionAffinity {
    private static final Pattern STATEFUL_STATEMENT = Pattern.compile(
        "(?is)(?:^|;)\\s*(?:BEGIN(?:\\s+(?:WORK|TRANSACTION))?\\b|START\\s+TRANSACTION\\b|SET\\b|RESET\\b|UNSET\\b|"
            + "USE\\b|DATABASE\\b|ALTER\\s+SESSION\\b|CREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?TEMP(?:ORARY)?\\b|"
            + "CREATE\\s+(?:(?:SET|MULTISET)\\s+)?VOLATILE\\b|CREATE\\s+TABLE\\s+(?:#{1,2}|\\[#{1,2})|"
            + "SELECT\\s+.+?\\s+INTO\\s+(?:(?:(?:GLOBAL|LOCAL)\\s+)?TEMP(?:ORARY)?\\b|#{1,2}|\\[#{1,2})|"
            + "DECLARE\\b|PREPARE\\b|DEALLOCATE\\b|ATTACH\\b|DETACH\\b|PRAGMA\\b|CALL\\b|EXEC(?:UTE)?\\b|DO\\b|"
            + "LISTEN\\b|UNLISTEN\\b|LOCK\\s+TABLES?\\b|UNLOCK\\s+TABLES?\\b|LOAD\\b|INSTALL\\b|"
            + "ADD\\s+(?:JAR|FILE|ARCHIVE)\\b|DELETE\\s+(?:JAR|FILE|ARCHIVE)\\b|CACHE\\s+TABLE\\b|UNCACHE\\s+TABLE\\b)"
    );
    private static final Pattern STATEFUL_FUNCTION = Pattern.compile(
        "(?is)\\b(?:SET_CONFIG|PG_ADVISORY_(?:XACT_)?LOCK|GET_LOCK|RELEASE_LOCK|SP_GETAPPLOCK|DBMS_LOCK)\\s*\\("
    );
    private static final Pattern USER_VARIABLE_ASSIGNMENT = Pattern.compile("(?is)(?:SET\\s+)?@[A-Z0-9_$]+\\s*(?::=|=)");
    private static final Pattern TEMPORARY_TABLE_REFERENCE = Pattern.compile(
        "(?is)(?:^|[^A-Z0-9_$])(?:#{1,2}|\\[#{1,2})[A-Z0-9_$]+"
    );

    private JdbcConnectionAffinity() {
    }

    static boolean requiresSessionAffinity(String sql) {
        if (sql == null) {
            return false;
        }
        String normalized = sanitizeSql(sql).trim().toUpperCase(Locale.ROOT);
        if (normalized.isEmpty()) {
            return false;
        }
        return STATEFUL_STATEMENT.matcher(normalized).find()
            || STATEFUL_FUNCTION.matcher(normalized).find()
            || USER_VARIABLE_ASSIGNMENT.matcher(normalized).find()
            || TEMPORARY_TABLE_REFERENCE.matcher(normalized).find();
    }

    private static String sanitizeSql(String sql) {
        StringBuilder sanitized = new StringBuilder(sql.length());
        int index = 0;
        while (index < sql.length()) {
            char current = sql.charAt(index);
            if (current == '-' && index + 1 < sql.length() && sql.charAt(index + 1) == '-') {
                index = sanitizeLineComment(sql, sanitized, index);
            } else if (current == '#' && isLineCommentStart(sql, index)) {
                index = sanitizeLineComment(sql, sanitized, index);
            } else if (current == '/' && index + 1 < sql.length() && sql.charAt(index + 1) == '*') {
                index = sanitizeBlockComment(sql, sanitized, index);
            } else if (current == '\'' || current == '"' || current == '`') {
                index = sanitizeQuoted(sql, sanitized, index, current);
            } else if (current == '[') {
                index = sanitizeQuoted(sql, sanitized, index, ']');
            } else if (current == '$') {
                String delimiter = dollarQuoteDelimiter(sql, index);
                if (delimiter == null) {
                    sanitized.append(current);
                    index += 1;
                } else {
                    int closing = sql.indexOf(delimiter, index + delimiter.length());
                    if (closing < 0) {
                        sanitized.append(current);
                        index += 1;
                    } else {
                        int end = closing + delimiter.length();
                        appendSanitized(sanitized, sql, index, end);
                        index = end;
                    }
                }
            } else {
                sanitized.append(current);
                index += 1;
            }
        }
        return sanitized.toString();
    }

    private static int sanitizeLineComment(String sql, StringBuilder sanitized, int start) {
        int end = start + (sql.charAt(start) == '#' ? 1 : 2);
        while (end < sql.length() && sql.charAt(end) != '\n' && sql.charAt(end) != '\r') {
            end += 1;
        }
        appendSanitized(sanitized, sql, start, end);
        return end;
    }

    private static int sanitizeBlockComment(String sql, StringBuilder sanitized, int start) {
        int closing = sql.indexOf("*/", start + 2);
        int end = closing < 0 ? sql.length() : closing + 2;
        int executableStart = executableCommentContentStart(sql, start, closing);
        if (executableStart >= 0) {
            appendSanitized(sanitized, sql, start, executableStart);
            sanitized.append(sanitizeSql(sql.substring(executableStart, closing)));
            appendSanitized(sanitized, sql, closing, end);
            return end;
        }
        appendSanitized(sanitized, sql, start, end);
        return end;
    }

    private static boolean isLineCommentStart(String sql, int index) {
        for (int previous = index - 1; previous >= 0; previous--) {
            char current = sql.charAt(previous);
            if (current == '\n' || current == '\r') {
                return true;
            }
            if (!Character.isWhitespace(current)) {
                return current == ';';
            }
        }
        return true;
    }

    private static int executableCommentContentStart(String sql, int start, int closing) {
        if (closing < 0) {
            return -1;
        }
        int contentStart;
        if (sql.startsWith("/*!", start)) {
            contentStart = start + 3;
        } else if (sql.startsWith("/*M!", start) || sql.startsWith("/*m!", start)) {
            contentStart = start + 4;
        } else {
            return -1;
        }
        while (contentStart < closing && Character.isDigit(sql.charAt(contentStart))) {
            contentStart += 1;
        }
        return contentStart;
    }

    private static int sanitizeQuoted(String sql, StringBuilder sanitized, int start, char closing) {
        int index = start + 1;
        while (index < sql.length()) {
            char current = sql.charAt(index);
            if (current == closing) {
                if (index + 1 < sql.length() && sql.charAt(index + 1) == closing) {
                    index += 2;
                    continue;
                }
                index += 1;
                break;
            }
            index += 1;
        }
        if (closing == ']' && start + 1 < sql.length() && sql.charAt(start + 1) == '#') {
            sanitized.append(sql, start, index);
        } else {
            appendSanitized(sanitized, sql, start, index);
        }
        return index;
    }

    private static String dollarQuoteDelimiter(String sql, int start) {
        int end = start + 1;
        while (end < sql.length()) {
            char current = sql.charAt(end);
            if (current == '$') {
                return sql.substring(start, end + 1);
            }
            if (!(Character.isLetterOrDigit(current) || current == '_')) {
                return null;
            }
            end += 1;
        }
        return null;
    }

    private static void appendSanitized(StringBuilder sanitized, String sql, int start, int end) {
        for (int index = start; index < end; index++) {
            char current = sql.charAt(index);
            sanitized.append(current == '\n' || current == '\r' ? current : ' ');
        }
    }
}

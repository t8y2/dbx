package com.dbx.agent;

import java.util.List;

/** Optional BLOB-only binding payload; preview text stays authoritative. */
public final class BlobBoundStatement {
    private String previewSql;
    private String sql;
    private List<String> blobParameters;

    public BlobBoundStatement(String previewSql, String sql, List<String> blobParameters) {
        this.previewSql = previewSql;
        this.sql = sql;
        this.blobParameters = blobParameters;
    }

    public String sql() { return sql; }
    public List<String> blobParameters() { return blobParameters; }

    public static void validate(List<String> statements, List<BlobBoundStatement> boundStatements) {
        if (statements == null || boundStatements == null || statements.size() != boundStatements.size()) {
            throw new IllegalArgumentException("BLOB bound statements must match the complete statement batch");
        }
        for (int i = 0; i < statements.size(); i++) {
            BlobBoundStatement bound = boundStatements.get(i);
            if (bound == null || statements.get(i) == null || !statements.get(i).equals(bound.previewSql)
                || bound.sql == null || bound.sql.trim().isEmpty() || bound.blobParameters == null) {
                throw new IllegalArgumentException("BLOB binding preview mismatch at statement " + (i + 1));
            }
            if (bound.blobParameters.isEmpty() && !bound.sql.equals(bound.previewSql)) {
                throw new IllegalArgumentException("Unbound statement SQL must match its preview");
            }
            SqlScan scan = scanSql(bound.sql);
            String visible = scan.visible().stripLeading().toUpperCase(java.util.Locale.ROOT);
            if (!visible.matches("(?s)^(?:UPDATE|INSERT|DELETE)\\b.*")
                && !visible.matches("(?s)^(?:DECLARE\\b.*?)?BEGIN\\s+(?:UPDATE|INSERT|DELETE)\\b.*")
                || java.util.regex.Pattern.compile("\\b(?:CREATE|ALTER|DROP|TRUNCATE|COMMIT|ROLLBACK|SAVEPOINT|GRANT|REVOKE|EXECUTE)\\b").matcher(visible).find()) {
                throw new IllegalArgumentException("BLOB binding only supports data-grid DML, without DDL or transaction control");
            }
            if (!bound.blobParameters.isEmpty() && scan.parameters() != bound.blobParameters.size()) {
                throw new IllegalArgumentException("BLOB parameter count does not match statement " + (i + 1));
            }
            for (String hex : bound.blobParameters) {
                if (hex == null || (hex.length() & 1) != 0) {
                    throw new IllegalArgumentException("BLOB parameters must contain even-length hexadecimal bytes");
                }
                for (int j = 0; j < hex.length(); j++) {
                    if (Character.digit(hex.charAt(j), 16) < 0 || hex.charAt(j) > 127) {
                        throw new IllegalArgumentException("BLOB parameters must contain hexadecimal bytes only");
                    }
                }
            }
        }
    }

    private record SqlScan(int parameters, String visible) { }

    private static SqlScan scanSql(String sql) {
        int count = 0;
        StringBuilder visible = new StringBuilder();
        for (int i = 0; i < sql.length(); i++) {
            char ch = sql.charAt(i);
            char next = i + 1 < sql.length() ? sql.charAt(i + 1) : '\0';
            if (ch == '-' && next == '-') {
                visible.append(' ');
                while (i + 1 < sql.length() && sql.charAt(i + 1) != '\n') i++;
            } else if (ch == '/' && next == '*') {
                visible.append(' ');
                int end = sql.indexOf("*/", i + 2);
                i = end < 0 ? sql.length() : end + 1;
            } else if ((ch == 'q' || ch == 'Q') && next == '\'' && i + 2 < sql.length()) {
                visible.append(' ');
                char open = sql.charAt(i + 2);
                char close = open == '[' ? ']' : open == '(' ? ')' : open == '{' ? '}' : open == '<' ? '>' : open;
                int end = sql.indexOf("" + close + '\'', i + 3);
                i = end < 0 ? sql.length() : end + 1;
            } else if (ch == '\'' || ch == '"') {
                visible.append(' ');
                char quote = ch;
                while (++i < sql.length()) {
                    if (sql.charAt(i) == quote) {
                        if (i + 1 < sql.length() && sql.charAt(i + 1) == quote) i++;
                        else break;
                    }
                }
            } else {
                visible.append(ch);
                if (ch == '?') count++;
            }
        }
        return new SqlScan(count, visible.toString());
    }
}

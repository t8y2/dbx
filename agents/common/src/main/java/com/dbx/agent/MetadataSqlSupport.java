package com.dbx.agent;

import java.sql.PreparedStatement;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public final class MetadataSqlSupport {
    private MetadataSqlSupport() {
    }

    public static void appendNameFilter(StringBuilder sql, List<Object> args, String column, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (!normalized.hasFilter()) {
            return;
        }
        sql.append(" AND UPPER(").append(column).append(") LIKE ? ESCAPE '\\\\'");
        args.add(normalized.fuzzyLikePattern().toUpperCase(Locale.ROOT));
    }

    public static void appendLimitOffset(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (!normalized.hasLimit()) {
            return;
        }
        sql.append(" LIMIT ?");
        args.add(normalized.getLimit());
        if (normalized.hasOffset()) {
            sql.append(" OFFSET ?");
            args.add(normalized.getOffset());
        }
    }

    public static void appendOffsetFetch(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (normalized.hasOffset()) {
            sql.append(" OFFSET ? ROWS");
            args.add(normalized.getOffset());
        }
        if (normalized.hasLimit()) {
            sql.append(normalized.hasOffset() ? " FETCH NEXT ? ROWS ONLY" : " FETCH FIRST ? ROWS ONLY");
            args.add(normalized.getLimit());
        }
    }

    public static void appendLiteralLimitOffset(StringBuilder sql, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (!normalized.hasLimit()) {
            return;
        }
        sql.append(" LIMIT ").append(normalized.getLimit());
        if (normalized.hasOffset()) {
            sql.append(" OFFSET ").append(normalized.getOffset());
        }
    }

    public static void appendLiteralOffsetFetch(StringBuilder sql, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (normalized.hasOffset()) {
            sql.append(" OFFSET ").append(normalized.getOffset()).append(" ROWS");
        }
        if (normalized.hasLimit()) {
            sql.append(normalized.hasOffset() ? " FETCH NEXT " : " FETCH FIRST ")
                .append(normalized.getLimit())
                .append(" ROWS ONLY");
        }
    }

    public static void appendLiteralSkipFirst(StringBuilder sql, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (normalized.hasOffset()) {
            sql.append("SKIP ").append(normalized.getOffset()).append(' ');
        }
        if (normalized.hasLimit()) {
            sql.append("FIRST ").append(normalized.getLimit()).append(' ');
        }
    }

    public static String placeholders(int count) {
        return String.join(", ", Collections.nCopies(count, "?"));
    }

    public static void bind(PreparedStatement stmt, List<Object> args) throws Exception {
        for (int index = 0; index < args.size(); index += 1) {
            Object arg = args.get(index);
            if (arg instanceof Integer) {
                stmt.setInt(index + 1, (Integer) arg);
            } else if (arg == null) {
                stmt.setObject(index + 1, null);
            } else {
                stmt.setString(index + 1, String.valueOf(arg));
            }
        }
    }
}

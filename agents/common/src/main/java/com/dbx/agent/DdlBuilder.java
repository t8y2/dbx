package com.dbx.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public final class DdlBuilder {
    private DdlBuilder() {
    }

    public static String buildTableDdl(
        String schema,
        String table,
        List<ColumnInfo> columns,
        List<IndexInfo> indexes,
        List<ForeignKeyInfo> foreignKeys
    ) {
        return buildTableDdl(schema, table, columns, indexes, foreignKeys, Collections.emptyList(), false, false, null);
    }

    public static String buildTableDdl(
        String schema,
        String table,
        List<ColumnInfo> columns,
        List<IndexInfo> indexes,
        List<ForeignKeyInfo> foreignKeys,
        boolean useBacktick
    ) {
        return buildTableDdl(schema, table, columns, indexes, foreignKeys, Collections.emptyList(), useBacktick, false, null);
    }

    public static String buildTableDdl(
        String schema,
        String table,
        List<ColumnInfo> columns,
        List<IndexInfo> indexes,
        List<ForeignKeyInfo> foreignKeys,
        boolean useBacktick,
        boolean includeColumnComments
    ) {
        return buildTableDdl(
            schema,
            table,
            columns,
            indexes,
            foreignKeys,
            Collections.emptyList(),
            useBacktick,
            includeColumnComments,
            null
        );
    }

    public static String buildTableDdl(
        String schema,
        String table,
        List<ColumnInfo> columns,
        List<IndexInfo> indexes,
        List<ForeignKeyInfo> foreignKeys,
        List<CheckConstraintInfo> checkConstraints,
        boolean useBacktick,
        boolean includeColumnComments
    ) {
        return buildTableDdl(schema, table, columns, indexes, foreignKeys, checkConstraints, useBacktick, includeColumnComments, null);
    }

    public static String buildTableDdl(
        String schema,
        String table,
        List<ColumnInfo> columns,
        List<IndexInfo> indexes,
        List<ForeignKeyInfo> foreignKeys,
        List<CheckConstraintInfo> checkConstraints,
        boolean useBacktick,
        boolean includeColumnComments,
        String tableComment
    ) {
        String tableRef = qualifiedName(schema, table, useBacktick);
        List<String> columnLines = new ArrayList<>();
        for (ColumnInfo column : columns) {
            StringBuilder line = new StringBuilder();
            line.append("  ");
            line.append(quoteIdent(column.getName(), useBacktick));
            line.append(" ");
            line.append(columnTypeSql(column));
            if (!column.getIs_nullable()) {
                line.append(" NOT NULL");
            }
            if (notBlank(column.getColumn_default())) {
                line.append(" DEFAULT ");
                line.append(column.getColumn_default());
            }
            columnLines.add(line.toString());
        }

        List<String> primaryKeys = new ArrayList<>();
        for (ColumnInfo column : columns) {
            if (column.getIs_primary_key()) {
                primaryKeys.add(quoteIdent(column.getName(), useBacktick));
            }
        }
        if (!primaryKeys.isEmpty()) {
            columnLines.add("  PRIMARY KEY (" + join(primaryKeys, ", ") + ")");
        }

        for (ForeignKeyInfo fk : foreignKeys) {
            columnLines.add(
                "  CONSTRAINT " + quoteIdent(fk.getName(), useBacktick)
                    + " FOREIGN KEY (" + quoteIdent(fk.getColumn(), useBacktick) + ") "
                    + "REFERENCES " + quoteIdent(fk.getRef_table(), useBacktick) + "(" + quoteIdent(fk.getRef_column(), useBacktick) + ")"
            );
        }

        for (CheckConstraintInfo constraint : checkConstraints) {
            if (!notBlank(constraint.getDefinition())) {
                continue;
            }
            String name = notBlank(constraint.getName())
                ? "CONSTRAINT " + quoteIdent(constraint.getName(), useBacktick) + " "
                : "";
            columnLines.add("  " + name + constraint.getDefinition());
        }

        StringBuilder ddl = new StringBuilder();
        ddl.append("CREATE TABLE ");
        ddl.append(tableRef);
        ddl.append(" (\n");
        ddl.append(join(columnLines, ",\n"));
        ddl.append("\n);\n");

        if (notBlank(tableComment)) {
            ddl.append("\nCOMMENT ON TABLE ");
            ddl.append(tableRef);
            ddl.append(" IS '");
            ddl.append(sqlStringBody(tableComment));
            ddl.append("';");
        }

        if (includeColumnComments) {
            for (ColumnInfo column : columns) {
                if (!notBlank(column.getComment())) {
                    continue;
                }
                ddl.append("\nCOMMENT ON COLUMN ");
                ddl.append(tableRef);
                ddl.append(".");
                ddl.append(quoteIdent(column.getName(), useBacktick));
                ddl.append(" IS '");
                ddl.append(sqlStringBody(column.getComment()));
                ddl.append("';");
            }
        }

        for (IndexInfo index : indexes) {
            if (index.getIs_primary()) {
                continue;
            }
            String unique = index.getIs_unique() ? "UNIQUE " : "";
            String using = notBlank(index.getIndex_type()) ? " USING " + index.getIndex_type() : "";
            List<String> quotedColumns = new ArrayList<>();
            for (String column : index.getColumns()) {
                quotedColumns.add(quoteIdent(column, useBacktick));
            }
            String filter = notBlank(index.getFilter()) ? " WHERE " + index.getFilter() : "";
            ddl.append("\nCREATE ");
            ddl.append(unique);
            ddl.append("INDEX ");
            ddl.append(quoteIdent(index.getName(), useBacktick));
            ddl.append(" ON ");
            ddl.append(tableRef);
            ddl.append(using);
            ddl.append(" (");
            ddl.append(join(quotedColumns, ", "));
            ddl.append(")");
            ddl.append(filter);
            ddl.append(";");
            if (notBlank(index.getComment())) {
                ddl.append("\nCOMMENT ON INDEX ");
                if (notBlank(schema)) {
                    ddl.append(quoteIdent(schema, useBacktick));
                    ddl.append(".");
                }
                ddl.append(quoteIdent(index.getName(), useBacktick));
                ddl.append(" IS '");
                ddl.append(sqlStringBody(index.getComment()));
                ddl.append("';");
            }
        }

        return ddl.toString();
    }

    private static String quoteIdent(String identifier, boolean useBacktick) {
        return useBacktick
            ? JdbcIdentifiers.INSTANCE.backtick(identifier)
            : JdbcIdentifiers.INSTANCE.doubleQuote(identifier);
    }

    private static String qualifiedName(String schema, String name, boolean useBacktick) {
        if (!notBlank(schema)) {
            return quoteIdent(name, useBacktick);
        }
        return quoteIdent(schema, useBacktick) + "." + quoteIdent(name, useBacktick);
    }

    private static String columnTypeSql(ColumnInfo column) {
        String type = column.getData_type();
        String normalized = type.toLowerCase(Locale.ROOT);
        if (isCharacterType(normalized) && column.getCharacter_maximum_length() != null) {
            return type + "(" + column.getCharacter_maximum_length() + ")";
        }
        if (isNumericType(normalized) && column.getNumeric_precision() != null) {
            if (column.getNumeric_scale() != null) {
                return type + "(" + column.getNumeric_precision() + ", " + column.getNumeric_scale() + ")";
            }
            return type + "(" + column.getNumeric_precision() + ")";
        }
        return type;
    }

    private static boolean isCharacterType(String normalized) {
        return "character varying".equals(normalized)
            || "varchar".equals(normalized)
            || "char".equals(normalized)
            || "character".equals(normalized);
    }

    private static boolean isNumericType(String normalized) {
        return "numeric".equals(normalized) || "decimal".equals(normalized);
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static String sqlStringBody(String value) {
        return value.replace("'", "''");
    }

    private static String join(List<String> values, String separator) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                builder.append(separator);
            }
            builder.append(values.get(i));
        }
        return builder.toString();
    }
}

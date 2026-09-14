package com.dbx.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class DdlBuilder {
    private static final Pattern SQLSERVER_IDENTITY = Pattern.compile(
        "^\\s*identity\\s*\\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\)\\s*$",
        Pattern.CASE_INSENSITIVE
    );

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
            String identityClause = sqlServerIdentityClause(column.getExtra());
            if (identityClause != null) {
                line.append(" ").append(identityClause);
            }
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
        for (IndexInfo index : indexes) {
            if (!index.getIs_primary() || index.getColumns().isEmpty()) {
                continue;
            }
            for (String column : index.getColumns()) {
                primaryKeys.add(quoteIdent(column, useBacktick));
            }
            break;
        }
        if (primaryKeys.isEmpty()) {
            for (ColumnInfo column : columns) {
                if (column.getIs_primary_key()) {
                    primaryKeys.add(quoteIdent(column.getName(), useBacktick));
                }
            }
        }
        if (!primaryKeys.isEmpty()) {
            columnLines.add("  PRIMARY KEY (" + join(primaryKeys, ", ") + ")");
        }

        for (ForeignKeyGroup foreignKey : groupForeignKeys(foreignKeys)) {
            String constraint = notBlank(foreignKey.name)
                ? "CONSTRAINT " + quoteIdent(foreignKey.name, useBacktick) + " "
                : "";
            columnLines.add(
                "  " + constraint
                    + "FOREIGN KEY (" + joinQuoted(foreignKey.columns, useBacktick) + ") "
                    + "REFERENCES " + quoteIdent(foreignKey.refTable, useBacktick)
                    + "(" + joinQuoted(foreignKey.refColumns, useBacktick) + ")"
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

    /**
     * Appends trailing SQL (e.g. GRANT statements) after a CREATE TABLE DDL script.
     * Returns the original DDL unchanged when {@code trailingSql} is blank.
     */
    public static String appendTrailingSql(String ddl, String trailingSql) {
        if (!notBlank(trailingSql)) {
            return ddl == null ? "" : ddl;
        }
        String base = ddl == null ? "" : ddl.trim();
        if (base.isEmpty()) {
            return trailingSql.trim();
        }
        if (!base.endsWith(";")) {
            base = base + ";";
        }
        String grants = trailingSql.trim();
        return base + "\n\n" + grants + (grants.endsWith(";") ? "" : ";");
    }

    /**
     * Builds Oracle-style object GRANT statements for table and column privileges.
     * Privileges are grouped by grantee / grantable / privilege(+columns).
     */
    public static String buildOracleObjectGrantSql(
        String schema,
        String table,
        List<OracleObjectPrivilege> privileges
    ) {
        if (privileges == null || privileges.isEmpty() || !notBlank(table)) {
            return "";
        }
        String tableRef = qualifiedName(schema, table, false);

        Map<String, List<String>> tablePrivileges = new LinkedHashMap<>();
        Map<String, List<String>> columnPrivileges = new LinkedHashMap<>();
        for (OracleObjectPrivilege privilege : privileges) {
            if (privilege == null || !notBlank(privilege.grantee()) || !notBlank(privilege.privilege())) {
                continue;
            }
            String privilegeName = privilege.privilege().trim().toUpperCase(Locale.ROOT);
            String grantableKey = privilege.grantable() ? "1" : "0";
            if (notBlank(privilege.columnName())) {
                String key = privilege.grantee() + "\u0000" + privilegeName + "\u0000" + grantableKey;
                columnPrivileges
                    .computeIfAbsent(key, ignored -> new ArrayList<>())
                    .add(privilege.columnName().trim());
            } else {
                String key = privilege.grantee() + "\u0000" + grantableKey;
                List<String> names = tablePrivileges.computeIfAbsent(key, ignored -> new ArrayList<>());
                if (!names.contains(privilegeName)) {
                    names.add(privilegeName);
                }
            }
        }

        List<String> statements = new ArrayList<>();
        for (Map.Entry<String, List<String>> entry : tablePrivileges.entrySet()) {
            String[] parts = entry.getKey().split("\u0000", -1);
            String grantee = parts[0];
            boolean grantable = "1".equals(parts[1]);
            statements.add(formatOracleGrant(
                join(entry.getValue(), ", "),
                null,
                tableRef,
                grantee,
                grantable
            ));
        }
        for (Map.Entry<String, List<String>> entry : columnPrivileges.entrySet()) {
            String[] parts = entry.getKey().split("\u0000", -1);
            String grantee = parts[0];
            String privilegeName = parts[1];
            boolean grantable = "1".equals(parts[2]);
            List<String> columns = new ArrayList<>();
            for (String column : entry.getValue()) {
                String quoted = quoteIdent(column, false);
                if (!columns.contains(quoted)) {
                    columns.add(quoted);
                }
            }
            statements.add(formatOracleGrant(
                privilegeName,
                join(columns, ", "),
                tableRef,
                grantee,
                grantable
            ));
        }
        return join(statements, "\n");
    }

    private static String formatOracleGrant(
        String privilegeList,
        String columnList,
        String tableRef,
        String grantee,
        boolean grantable
    ) {
        StringBuilder statement = new StringBuilder("GRANT ");
        statement.append(privilegeList);
        if (notBlank(columnList)) {
            statement.append(" (").append(columnList).append(")");
        }
        statement.append(" ON ").append(tableRef);
        statement.append(" TO ").append(quoteIdent(grantee, false));
        if (grantable) {
            statement.append(" WITH GRANT OPTION");
        }
        statement.append(";");
        return statement.toString();
    }

    private static List<ForeignKeyGroup> groupForeignKeys(List<ForeignKeyInfo> foreignKeys) {
        List<ForeignKeyGroup> result = new ArrayList<>();
        Map<String, ForeignKeyGroup> namedGroups = new LinkedHashMap<>();
        for (ForeignKeyInfo foreignKey : foreignKeys) {
            ForeignKeyGroup group = null;
            if (notBlank(foreignKey.getName()) && notBlank(foreignKey.getRef_table())) {
                String groupKey = foreignKey.getName() + "\u0000" + foreignKey.getRef_table();
                group = namedGroups.get(groupKey);
                if (group == null) {
                    group = new ForeignKeyGroup(foreignKey.getName(), foreignKey.getRef_table());
                    namedGroups.put(groupKey, group);
                    result.add(group);
                }
            }
            if (group == null) {
                group = new ForeignKeyGroup(foreignKey.getName(), foreignKey.getRef_table());
                result.add(group);
            }
            group.columns.add(foreignKey.getColumn());
            group.refColumns.add(foreignKey.getRef_column());
        }
        return result;
    }

    private static String joinQuoted(List<String> values, boolean useBacktick) {
        List<String> quotedValues = new ArrayList<>();
        for (String value : values) {
            quotedValues.add(quoteIdent(value, useBacktick));
        }
        return join(quotedValues, ", ");
    }

    private static final class ForeignKeyGroup {
        private final String name;
        private final String refTable;
        private final List<String> columns = new ArrayList<>();
        private final List<String> refColumns = new ArrayList<>();

        private ForeignKeyGroup(String name, String refTable) {
            this.name = name;
            this.refTable = refTable;
        }
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
        Integer characterLength = column.getCharacter_maximum_length();
        if (isCharacterType(normalized) && characterLength != null && characterLength > 0) {
            return type + "(" + characterLength + ")";
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
            || "nvarchar".equals(normalized)
            || "char".equals(normalized)
            || "nchar".equals(normalized)
            || "character".equals(normalized);
    }

    private static boolean isNumericType(String normalized) {
        return "numeric".equals(normalized) || "decimal".equals(normalized);
    }

    private static String sqlServerIdentityClause(String extra) {
        if (extra == null) {
            return null;
        }
        Matcher matcher = SQLSERVER_IDENTITY.matcher(extra);
        return matcher.matches() ? "IDENTITY(" + matcher.group(1) + "," + matcher.group(2) + ")" : null;
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

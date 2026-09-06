package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Renders a CREATE TABLE statement from the plugin's generic JDBC metadata
 * nodes. Used for external drivers that expose no vendor DDL statement, where
 * {@code DatabaseMetaData} is the only portable metadata source. Identifiers
 * are double-quoted per the SQL standard, matching the agent-side DdlBuilder.
 */
final class GenericJdbcDdlBuilder {

    private GenericJdbcDdlBuilder() {
    }

    static String buildTableDdl(String schema, String table, JsonNode columns, JsonNode indexes, JsonNode foreignKeys) {
        String tableRef = qualifiedName(schema, table);
        List<String> columnLines = new ArrayList<>();
        for (JsonNode column : columns) {
            String name = column.path("name").asText("");
            if (!name.isBlank()) {
                columnLines.add(columnLine(column, name));
            }
        }

        Set<String> primaryKeys = primaryKeysFromIndexes(indexes);
        if (primaryKeys.isEmpty()) {
            primaryKeys = primaryKeysFromColumnFlags(columns);
        }
        if (!primaryKeys.isEmpty()) {
            columnLines.add("  PRIMARY KEY (" + joinQuoted(primaryKeys) + ")");
        }

        List<ForeignKeyGroup> foreignKeyGroups = groupForeignKeys(foreignKeys);
        for (ForeignKeyGroup group : foreignKeyGroups) {
            String constraint = notBlank(group.name) ? "CONSTRAINT " + quoteIdent(group.name) + " " : "";
            columnLines.add(
                "  " + constraint
                    + "FOREIGN KEY (" + joinQuoted(group.columns) + ") "
                    + "REFERENCES " + quoteIdent(group.refTable)
                    + " (" + joinQuoted(group.refColumns) + ")"
            );
        }
        Set<String> foreignKeyColumnSets = new LinkedHashSet<>();
        for (ForeignKeyGroup group : foreignKeyGroups) {
            foreignKeyColumnSets.add(String.join("\u0000", group.columns));
        }

        StringBuilder ddl = new StringBuilder();
        ddl.append("CREATE TABLE ").append(tableRef).append(" (\n");
        ddl.append(String.join(",\n", columnLines));
        ddl.append("\n);\n");

        for (JsonNode index : indexes) {
            if (index.path("is_primary").asBoolean()) {
                continue;
            }
            String name = index.path("name").asText("");
            List<String> indexColumns = textValues(index.path("columns"));
            if (name.isBlank() || indexColumns.isEmpty()) {
                continue;
            }
            if (!index.path("is_unique").asBoolean() && foreignKeyColumnSets.contains(String.join("\u0000", indexColumns))) {
                // Many engines auto-create this index for the FOREIGN KEY
                // constraint itself; re-creating it would collide on restore.
                continue;
            }
            String unique = index.path("is_unique").asBoolean() ? "UNIQUE " : "";
            ddl.append("\nCREATE ").append(unique).append("INDEX ").append(quoteIdent(name));
            ddl.append(" ON ").append(tableRef);
            ddl.append(" (").append(String.join(", ", quoteAll(indexColumns))).append(");\n");
        }

        return ddl.toString();
    }

    private static String columnLine(JsonNode column, String name) {
        StringBuilder line = new StringBuilder("  ").append(quoteIdent(name));
        String type = column.path("data_type").asText("");
        if (!type.isBlank()) {
            line.append(" ").append(typeWithLength(column, type));
        }
        if (!column.path("is_nullable").asBoolean(true)) {
            line.append(" NOT NULL");
        }
        String defaultValue = column.path("column_default").asText("");
        if (!defaultValue.isBlank()) {
            line.append(" DEFAULT ").append(defaultValue);
        }
        return line.toString();
    }

    private static String typeWithLength(JsonNode column, String type) {
        String normalized = type.toLowerCase(java.util.Locale.ROOT);
        Integer characterLength = nullableInt(column, "character_maximum_length");
        if (isCharacterType(normalized) && characterLength != null && characterLength > 0) {
            return type + "(" + characterLength + ")";
        }
        Integer precision = nullableInt(column, "numeric_precision");
        if (isNumericType(normalized) && precision != null) {
            Integer scale = nullableInt(column, "numeric_scale");
            return scale != null ? type + "(" + precision + ", " + scale + ")" : type + "(" + precision + ")";
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

    private static Set<String> primaryKeysFromIndexes(JsonNode indexes) {
        for (JsonNode index : indexes) {
            if (index.path("is_primary").asBoolean()) {
                Set<String> columns = new LinkedHashSet<>(textValues(index.path("columns")));
                if (!columns.isEmpty()) {
                    return columns;
                }
            }
        }
        return Set.of();
    }

    private static Set<String> primaryKeysFromColumnFlags(JsonNode columns) {
        Set<String> primaryKeys = new LinkedHashSet<>();
        for (JsonNode column : columns) {
            if (column.path("is_primary_key").asBoolean()) {
                String name = column.path("name").asText("");
                if (!name.isBlank()) {
                    primaryKeys.add(name);
                }
            }
        }
        return primaryKeys;
    }

    private static List<ForeignKeyGroup> groupForeignKeys(JsonNode foreignKeys) {
        List<ForeignKeyGroup> ordered = new ArrayList<>();
        Map<String, ForeignKeyGroup> namedGroups = new LinkedHashMap<>();
        for (JsonNode foreignKey : foreignKeys) {
            String name = foreignKey.path("name").asText("");
            String refTable = foreignKey.path("ref_table").asText("");
            String column = foreignKey.path("column").asText("");
            String refColumn = foreignKey.path("ref_column").asText("");
            if (column.isBlank() || refTable.isBlank() || refColumn.isBlank()) {
                continue;
            }
            ForeignKeyGroup group = null;
            if (notBlank(name)) {
                group = namedGroups.get(name + "\u0000" + refTable);
            }
            if (group == null) {
                group = new ForeignKeyGroup(name, refTable);
                ordered.add(group);
                if (notBlank(name)) {
                    namedGroups.put(name + "\u0000" + refTable, group);
                }
            }
            group.columns.add(column);
            group.refColumns.add(refColumn);
        }
        return ordered;
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

    private static String qualifiedName(String schema, String name) {
        if (!notBlank(schema)) {
            return quoteIdent(name);
        }
        return quoteIdent(schema) + "." + quoteIdent(name);
    }

    private static String quoteIdent(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private static String joinQuoted(Iterable<String> values) {
        return String.join(", ", quoteAll(values));
    }

    private static List<String> quoteAll(Iterable<String> values) {
        List<String> quoted = new ArrayList<>();
        for (String value : values) {
            quoted.add(quoteIdent(value));
        }
        return quoted;
    }

    private static List<String> textValues(JsonNode array) {
        List<String> values = new ArrayList<>();
        if (array.isArray()) {
            for (JsonNode value : array) {
                String text = value.asText("");
                if (!text.isBlank()) {
                    values.add(text);
                }
            }
        }
        return values;
    }

    private static Integer nullableInt(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isMissingNode() || value.isNull() ? null : value.asInt();
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }
}

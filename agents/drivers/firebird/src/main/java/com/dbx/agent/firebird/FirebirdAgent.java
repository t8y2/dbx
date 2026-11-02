package com.dbx.agent.firebird;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.nio.charset.Charset;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

public final class FirebirdAgent extends ConfiguredJdbcAgent {
    private static final String COMMON_OBJECTS_SQL = """
        SELECT TRIM(RDB$GENERATOR_NAME) AS OBJECT_NAME, 'SEQUENCE' AS OBJECT_TYPE, NULL AS OBJECT_COMMENT
          FROM RDB$GENERATORS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0
        UNION ALL
        SELECT TRIM(RDB$TRIGGER_NAME), 'TRIGGER', TRIM(RDB$RELATION_NAME)
          FROM RDB$TRIGGERS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0
        UNION ALL
        SELECT TRIM(RDB$INDEX_NAME), 'INDEX', TRIM(RDB$RELATION_NAME)
          FROM RDB$INDICES WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0
        """.stripIndent().trim();

    static String catalogObjectsSql(int majorVersion) {
        if (majorVersion < 3) {
            return COMMON_OBJECTS_SQL + " UNION ALL SELECT TRIM(RDB$FUNCTION_NAME), 'FUNCTION_UDF', TRIM(RDB$MODULE_NAME) FROM RDB$FUNCTIONS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0";
        }
        return COMMON_OBJECTS_SQL + " UNION ALL " + """
            SELECT TRIM(RDB$PACKAGE_NAME), 'PACKAGE', NULL
              FROM RDB$PACKAGES WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0
            UNION ALL
            SELECT CASE WHEN RDB$PACKAGE_NAME IS NULL THEN TRIM(RDB$FUNCTION_NAME)
                        ELSE TRIM(RDB$PACKAGE_NAME) || '.' || TRIM(RDB$FUNCTION_NAME) END,
                   CASE WHEN NULLIF(TRIM(RDB$MODULE_NAME),'') IS NULL AND NULLIF(TRIM(RDB$ENGINE_NAME),'') IS NULL
                        THEN 'FUNCTION_INTERNAL' ELSE 'FUNCTION_UDF' END,
                   COALESCE(NULLIF(TRIM(RDB$MODULE_NAME), ''), NULLIF(TRIM(RDB$ENGINE_NAME), ''))
              FROM RDB$FUNCTIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0
            """.stripIndent().trim();
    }
    private Charset dataCharset;

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        if (table == null || table.isBlank()) {
            return Collections.emptyList();
        }
        String normalizedTable = table.trim();
        if (normalizedTable.startsWith("\"") && normalizedTable.endsWith("\"") && normalizedTable.length() > 1) {
            normalizedTable = normalizedTable.substring(1, normalizedTable.length() - 1);
        }
        final String searchTable = normalizedTable;
        return unchecked(() -> {
            List<TriggerInfo> triggers = new ArrayList<>();
            try (PreparedStatement statement = requireConnection().prepareStatement(
                "SELECT TRIM(RDB$TRIGGER_NAME), RDB$TRIGGER_TYPE FROM RDB$TRIGGERS WHERE (TRIM(RDB$RELATION_NAME) = ? OR TRIM(RDB$RELATION_NAME) = UPPER(?)) AND COALESCE(RDB$SYSTEM_FLAG,0)=0 ORDER BY RDB$TRIGGER_NAME")) {
                statement.setString(1, searchTable);
                statement.setString(2, searchTable);
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        int type = result.getInt(2);
                        triggers.add(new TriggerInfo(result.getString(1), triggerEvent(type), type % 2 == 1 ? "BEFORE" : "AFTER"));
                    }
                }
            }
            return triggers;
        });
    }

    static String triggerEvent(int type) {
        return switch (type) {
            case 1, 2 -> "INSERT";
            case 3, 4 -> "UPDATE";
            case 5, 6 -> "DELETE";
            case 17, 18 -> "INSERT OR UPDATE";
            case 25, 26 -> "INSERT OR DELETE";
            case 27, 28 -> "UPDATE OR DELETE";
            case 113, 114 -> "INSERT OR UPDATE OR DELETE";
            case 8192 -> "CONNECT";
            case 8193 -> "DISCONNECT";
            case 8194 -> "TRANSACTION START";
            case 8195 -> "TRANSACTION COMMIT";
            case 8196 -> "TRANSACTION ROLLBACK";
            default -> Integer.toString(type);
        };
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        String url = super.buildJdbcUrl(params);
        LegacyTextDecoder.charsetFromUrl(url); // Fail invalid configuration before opening a connection.
        return LegacyTextDecoder.jdbcUrl(url);
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        super.afterConnect(params, connection);
        dataCharset = LegacyTextDecoder.charsetFromUrl(super.buildJdbcUrl(params));
    }

    @Override
    protected Object resultValue(ResultSet resultSet, int index, int sqlType) {
        Object value = super.resultValue(resultSet, index, sqlType);
        return switch (sqlType) {
            case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR,
                Types.NCHAR, Types.NVARCHAR, Types.LONGNVARCHAR, Types.CLOB, Types.NCLOB ->
                value instanceof String text ? decodeLegacyText(text) : value;
            default -> value;
        };
    }

    private String decodeLegacyText(String value) {
        return LegacyTextDecoder.decode(value, dataCharset);
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        List<ColumnInfo> columns = super.getColumns(schema, table);
        for (ColumnInfo column : columns) column.setComment(decodeLegacyText(column.getComment()));
        return columns;
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return listTables(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        List<TableInfo> tables = super.listTables(schema, constraints);
        for (TableInfo table : tables) table.setComment(decodeLegacyText(table.getComment()));
        return tables;
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return listObjects(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        List<ObjectInfo> objects = new ArrayList<>(super.listObjects(schema, MetadataListConstraints.NONE));
        // JDBC metadata flattens all Firebird functions into FUNCTION and does
        // not expose generators, packages, database triggers, or indexes. Use
        // the Firebird catalogs so the object browser can keep those categories
        // distinct without changing the table-scoped metadata APIs.
        for (Iterator<ObjectInfo> iterator = objects.iterator(); iterator.hasNext();) {
            ObjectInfo object = iterator.next();
            if ("FUNCTION".equalsIgnoreCase(object.getObject_type())) iterator.remove();
        }
        unchecked(() -> {
            try (PreparedStatement statement = requireConnection().prepareStatement(catalogObjectsSql(requireConnection().getMetaData().getDatabaseMajorVersion()));
                 ResultSet resultSet = statement.executeQuery()) {
                while (resultSet.next()) {
                    String name = trimToNull(resultSet.getString("OBJECT_NAME"));
                    String type = trimToNull(resultSet.getString("OBJECT_TYPE"));
                    if (name == null || type == null) continue;
                    String comment = decodeLegacyText(trimToNull(resultSet.getString("OBJECT_COMMENT")));
                    ObjectInfo object = new ObjectInfo(name, type, schema, comment);
                    if ("INDEX".equals(type) || "TRIGGER".equals(type)) {
                        object.setParent_name(comment);
                        object.setComment(null);
                    }
                    objects.add(object);
                }
            }
            return null;
        });
        for (ObjectInfo object : objects) object.setComment(decodeLegacyText(object.getComment()));
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        // Preserve the existing FUNCTION metadata request used by older clients
        // while exposing the two precise categories to the new object browser.
        if (normalized.getObjectTypes() != null && normalized.getObjectTypes().contains("FUNCTION")) {
            for (ObjectInfo object : objects) {
                if (object.getObject_type().startsWith("FUNCTION_")) object.setObject_type("FUNCTION");
            }
        }
        objects.sort(Comparator.comparing(ObjectInfo::getName).thenComparing(ObjectInfo::getObject_type));
        return normalized.filterObjects(objects);
    }
    static final String PROCEDURE_SOURCE_SQL = """
        SELECT
            CASE WHEN METADATA_ROW = 1 THEN PROCEDURE_SOURCE ELSE NULL END AS PROCEDURE_SOURCE,
            PARAMETER_NAME,
            PARAMETER_TYPE,
            PARAMETER_NUMBER,
            FIELD_SOURCE,
            PARAMETER_DEFAULT,
            PARAMETER_NULL_FLAG,
            FIELD_TYPE,
            FIELD_SUB_TYPE,
            FIELD_PRECISION,
            FIELD_SCALE,
            FIELD_LENGTH,
            CHAR_COUNT
        FROM (
            SELECT
                P.RDB$PROCEDURE_SOURCE AS PROCEDURE_SOURCE,
                TRIM(PP.RDB$PARAMETER_NAME) AS PARAMETER_NAME,
                PP.RDB$PARAMETER_TYPE AS PARAMETER_TYPE,
                PP.RDB$PARAMETER_NUMBER AS PARAMETER_NUMBER,
                TRIM(PP.RDB$FIELD_SOURCE) AS FIELD_SOURCE,
                PP.RDB$DEFAULT_SOURCE AS PARAMETER_DEFAULT,
                PP.RDB$NULL_FLAG AS PARAMETER_NULL_FLAG,
                F.RDB$FIELD_TYPE AS FIELD_TYPE,
                F.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
                F.RDB$FIELD_PRECISION AS FIELD_PRECISION,
                F.RDB$FIELD_SCALE AS FIELD_SCALE,
                F.RDB$FIELD_LENGTH AS FIELD_LENGTH,
                F.RDB$CHARACTER_LENGTH AS CHAR_COUNT,
                ROW_NUMBER() OVER (
                    ORDER BY PP.RDB$PARAMETER_TYPE, PP.RDB$PARAMETER_NUMBER
                ) AS METADATA_ROW
            FROM RDB$PROCEDURES P
            LEFT JOIN RDB$PROCEDURE_PARAMETERS PP
                ON PP.RDB$PROCEDURE_NAME = P.RDB$PROCEDURE_NAME
                AND PP.RDB$PACKAGE_NAME IS NOT DISTINCT FROM P.RDB$PACKAGE_NAME
            LEFT JOIN RDB$FIELDS F
                ON F.RDB$FIELD_NAME = PP.RDB$FIELD_SOURCE
            WHERE P.RDB$PROCEDURE_NAME = ?
                AND P.RDB$PACKAGE_NAME IS NULL
        ) PROCEDURE_METADATA
        ORDER BY PARAMETER_TYPE, PARAMETER_NUMBER
        """.stripIndent().trim();

    public static final JdbcAgentProfile FIREBIRD_PROFILE = new JdbcAgentProfile(
        "org.firebirdsql.jdbc.FBDriver",
        "jdbc:firebirdsql://{host}:{port}/{database}",
        3050,
        true
    );

    public FirebirdAgent() {
        super(FIREBIRD_PROFILE);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String requestedType = normalizeObjectSourceType(objectType);
        if (!"PROCEDURE".equals(requestedType)) {
            return unchecked(() -> FirebirdObjectSource.read(requireConnection(), schema, name, requestedType, this::decodeLegacyText));
        }
        String normalizedType = normalizeObjectSourceType(objectType);
        return unchecked(() -> {
            String body = null;
            boolean found = false;
            List<ProcedureParameter> inputs = new ArrayList<>();
            List<ProcedureParameter> outputs = new ArrayList<>();
            try (PreparedStatement statement = requireConnection().prepareStatement(PROCEDURE_SOURCE_SQL)) {
                statement.setString(1, name);
                try (ResultSet resultSet = statement.executeQuery()) {
                    while (resultSet.next()) {
                        found = true;
                        if (body == null) {
                            body = decodeLegacyText(resultSet.getString("PROCEDURE_SOURCE"));
                        }
                        String parameterName = trimToNull(resultSet.getString("PARAMETER_NAME"));
                        if (parameterName == null) {
                            continue;
                        }
                        ProcedureParameter parameter = new ProcedureParameter(
                            parameterName,
                            trimToNull(resultSet.getString("FIELD_SOURCE")),
                            trimToNull(resultSet.getString("PARAMETER_DEFAULT")),
                            nullableInt(resultSet, "PARAMETER_NULL_FLAG"),
                            nullableInt(resultSet, "FIELD_TYPE"),
                            nullableInt(resultSet, "FIELD_SUB_TYPE"),
                            nullableInt(resultSet, "FIELD_PRECISION"),
                            nullableInt(resultSet, "FIELD_SCALE"),
                            nullableInt(resultSet, "FIELD_LENGTH"),
                            nullableInt(resultSet, "CHAR_COUNT")
                        );
                        int parameterType = resultSet.getInt("PARAMETER_TYPE");
                        if (parameterType == 0) {
                            inputs.add(parameter);
                        } else if (parameterType == 1) {
                            outputs.add(parameter);
                        } else {
                            throw new IllegalStateException("Unsupported Firebird parameter type: " + parameterType);
                        }
                    }
                }
            }

            String source = !found || body == null || body.isBlank()
                ? ""
                : buildProcedureDdl(name, inputs, outputs, body);
            return new ObjectSource(name, normalizedType, schema, source, false);
        });
    }

    static String normalizeObjectSourceType(String objectType) {
        if (objectType == null) {
            throw new IllegalArgumentException("Unsupported object type: null");
        }
        String normalized = objectType.trim().toUpperCase(Locale.ROOT);
        if (!List.of("PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "PACKAGE", "PACKAGE_BODY", "VIEW").contains(normalized)) {
            throw new IllegalArgumentException("Unsupported object type: " + objectType);
        }
        return normalized;
    }

    private static String buildProcedureDdl(
        String name,
        List<ProcedureParameter> inputs,
        List<ProcedureParameter> outputs,
        String body
    ) {
        StringBuilder ddl = new StringBuilder("CREATE OR ALTER PROCEDURE ")
            .append(quoteIdentifier(name));
        appendParameterBlock(ddl, inputs, " (");
        if (inputs.isEmpty()) {
            ddl.append('\n');
        }
        if (!outputs.isEmpty()) {
            appendParameterBlock(ddl, outputs, "RETURNS (");
        }
        ddl.append("AS\n").append(body);
        if (!body.endsWith("\n")) {
            ddl.append('\n');
        }
        return ddl.toString();
    }

    private static void appendParameterBlock(
        StringBuilder ddl,
        List<ProcedureParameter> parameters,
        String prefix
    ) {
        if (parameters.isEmpty()) {
            return;
        }
        ddl.append(prefix).append('\n');
        for (int index = 0; index < parameters.size(); index++) {
            ddl.append("  ").append(parameterDeclaration(parameters.get(index)));
            if (index + 1 < parameters.size()) {
                ddl.append(',');
            }
            ddl.append('\n');
        }
        ddl.append(")\n");
    }

    private static String parameterDeclaration(ProcedureParameter parameter) {
        StringBuilder declaration = new StringBuilder(quoteIdentifier(parameter.name()))
            .append(' ')
            .append(parameterType(parameter));
        if (Integer.valueOf(1).equals(parameter.notNull())) {
            declaration.append(" NOT NULL");
        }
        if (parameter.defaultSource() != null) {
            declaration.append(' ').append(parameter.defaultSource());
        }
        return declaration.toString();
    }

    private static String parameterType(ProcedureParameter parameter) {
        if (parameter.fieldSource() != null && !parameter.fieldSource().startsWith("RDB$")) {
            return quoteIdentifier(parameter.fieldSource());
        }
        if (parameter.fieldType() == null) {
            throw new IllegalStateException("Missing Firebird field type for parameter " + parameter.name());
        }
        int fieldType = parameter.fieldType();
        int subType = valueOrZero(parameter.fieldSubType());
        return switch (fieldType) {
            case 7 -> numericType("SMALLINT", subType, parameter);
            case 8 -> numericType("INTEGER", subType, parameter);
            case 10 -> "FLOAT";
            case 11, 27 -> "DOUBLE PRECISION";
            case 12 -> "DATE";
            case 13 -> "TIME";
            case 14 -> characterType("CHAR", "BINARY", subType, parameter);
            case 16 -> numericType("BIGINT", subType, parameter);
            case 23 -> "BOOLEAN";
            case 24 -> "DECFLOAT(16)";
            case 25 -> "DECFLOAT(34)";
            case 26 -> numericType("INT128", subType, parameter);
            case 28 -> "TIME WITH TIME ZONE";
            case 29 -> "TIMESTAMP WITH TIME ZONE";
            case 35 -> "TIMESTAMP";
            case 37 -> characterType("VARCHAR", "VARBINARY", subType, parameter);
            case 40 -> sizedType("CSTRING", characterLength(parameter));
            case 261 -> blobType(subType);
            default -> throw new IllegalStateException("Unsupported Firebird field type: " + fieldType);
        };
    }

    private static String numericType(String integerType, int subType, ProcedureParameter parameter) {
        int scale = valueOrZero(parameter.scale());
        if (subType != 1 && subType != 2 && scale >= 0) {
            return integerType;
        }
        String exactType = subType == 2 ? "DECIMAL" : "NUMERIC";
        int precision = valueOrZero(parameter.precision());
        if (precision <= 0) {
            return exactType;
        }
        return exactType + "(" + precision + "," + Math.abs(scale) + ")";
    }

    private static String characterType(
        String characterType,
        String binaryType,
        int subType,
        ProcedureParameter parameter
    ) {
        return sizedType(subType == 1 ? binaryType : characterType, characterLength(parameter));
    }

    private static String sizedType(String type, Integer size) {
        return size == null || size <= 0 ? type : type + "(" + size + ")";
    }

    private static int characterLength(ProcedureParameter parameter) {
        Integer charCount = parameter.charCount();
        return charCount != null && charCount > 0
            ? charCount
            : valueOrZero(parameter.fieldLength());
    }

    private static String blobType(int subType) {
        if (subType == 0) {
            return "BLOB";
        }
        return subType == 1 ? "BLOB SUB_TYPE TEXT" : "BLOB SUB_TYPE " + subType;
    }

    private static String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private static String trimToNull(String value) {
        if (value == null || value.trim().isEmpty()) {
            return null;
        }
        return value.trim();
    }

    private static Integer nullableInt(ResultSet resultSet, String column) throws Exception {
        int value = resultSet.getInt(column);
        return resultSet.wasNull() ? null : value;
    }

    private static int valueOrZero(Integer value) {
        return value == null ? 0 : value;
    }

    private record ProcedureParameter(
        String name,
        String fieldSource,
        String defaultSource,
        Integer notNull,
        Integer fieldType,
        Integer fieldSubType,
        Integer precision,
        Integer scale,
        Integer fieldLength,
        Integer charCount
    ) {
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(FirebirdAgent::new).run();
    }
}

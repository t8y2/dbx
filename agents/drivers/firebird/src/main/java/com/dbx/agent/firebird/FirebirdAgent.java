package com.dbx.agent.firebird;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class FirebirdAgent extends ConfiguredJdbcAgent {
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
                            body = resultSet.getString("PROCEDURE_SOURCE");
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
        if (!"PROCEDURE".equals(normalized)) {
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

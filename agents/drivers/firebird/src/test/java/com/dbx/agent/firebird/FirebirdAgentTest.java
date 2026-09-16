package com.dbx.agent.firebird;

import com.dbx.agent.ObjectSource;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class FirebirdAgentTest {
    private static final String EXPECTED_PROCEDURE_SOURCE_SQL = """
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

    @Test
    void returnsCompleteProcedureDdlFromOneMetadataQuery() {
        List<String> sql = new ArrayList<>();
        List<String> parameters = new ArrayList<>();
        FirebirdAgent agent = agentWithRows(
            sql,
            parameters,
            row(
                "PROCEDURE_SOURCE", procedureBody(),
                "PARAMETER_NAME", "P_ID",
                "PARAMETER_TYPE", 0,
                "PARAMETER_NUMBER", 0,
                "FIELD_SOURCE", "RDB$1",
                "FIELD_TYPE", 8,
                "FIELD_SUB_TYPE", 0,
                "FIELD_PRECISION", 0,
                "FIELD_SCALE", 0,
                "FIELD_LENGTH", 4
            ),
            row(
                "PROCEDURE_SOURCE", null,
                "PARAMETER_NAME", "P_LABEL",
                "PARAMETER_TYPE", 0,
                "PARAMETER_NUMBER", 1,
                "FIELD_SOURCE", "RDB$2",
                "PARAMETER_DEFAULT", "DEFAULT 'fallback'",
                "FIELD_TYPE", 37,
                "FIELD_SUB_TYPE", 0,
                "FIELD_SCALE", 0,
                "FIELD_LENGTH", 80,
                "CHAR_COUNT", 20
            ),
            row(
                "PROCEDURE_SOURCE", null,
                "PARAMETER_NAME", "P_DOM",
                "PARAMETER_TYPE", 0,
                "PARAMETER_NUMBER", 2,
                "FIELD_SOURCE", "D_6141",
                "PARAMETER_DEFAULT", "DEFAULT 'domain'",
                "FIELD_TYPE", 37,
                "FIELD_SUB_TYPE", 0,
                "FIELD_SCALE", 0,
                "FIELD_LENGTH", 48,
                "CHAR_COUNT", 12
            ),
            row(
                "PROCEDURE_SOURCE", null,
                "PARAMETER_NAME", "O_ID",
                "PARAMETER_TYPE", 1,
                "PARAMETER_NUMBER", 0,
                "FIELD_SOURCE", "RDB$3",
                "FIELD_TYPE", 16,
                "FIELD_SUB_TYPE", 0,
                "FIELD_PRECISION", 0,
                "FIELD_SCALE", 0,
                "FIELD_LENGTH", 8
            ),
            row(
                "PROCEDURE_SOURCE", null,
                "PARAMETER_NAME", "O_TEXT",
                "PARAMETER_TYPE", 1,
                "PARAMETER_NUMBER", 1,
                "FIELD_SOURCE", "RDB$4",
                "FIELD_TYPE", 37,
                "FIELD_SUB_TYPE", 0,
                "FIELD_SCALE", 0,
                "FIELD_LENGTH", 160,
                "CHAR_COUNT", 40
            )
        );

        ObjectSource source = agent.getObjectSource(null, "P_6141", " procedure ");

        Assertions.assertEquals(List.of(EXPECTED_PROCEDURE_SOURCE_SQL), sql);
        Assertions.assertEquals(List.of("1=P_6141"), parameters);
        Assertions.assertEquals("P_6141", source.getName());
        Assertions.assertEquals("PROCEDURE", source.getObject_type());
        Assertions.assertNull(source.getSchema());
        Assertions.assertFalse(source.isEditable());
        Assertions.assertEquals(
            """
            CREATE OR ALTER PROCEDURE "P_6141" (
              "P_ID" INTEGER,
              "P_LABEL" VARCHAR(20) DEFAULT 'fallback',
              "P_DOM" "D_6141" DEFAULT 'domain'
            )
            RETURNS (
              "O_ID" BIGINT,
              "O_TEXT" VARCHAR(40)
            )
            AS
            DECLARE VARIABLE V_NOTE VARCHAR(20);
            BEGIN
              O_ID = P_ID;
              O_TEXT = P_LABEL || ':' || P_DOM;
              SUSPEND;
            END
            """,
            source.getSource()
        );
    }

    @Test
    void quotesMixedCaseIdentifiersAndBindsRoutineName() {
        List<String> sql = new ArrayList<>();
        List<String> parameters = new ArrayList<>();
        FirebirdAgent agent = agentWithRows(
            sql,
            parameters,
            row(
                "PROCEDURE_SOURCE", "BEGIN\nEND",
                "PARAMETER_NAME", "Arg\"Name",
                "PARAMETER_TYPE", 0,
                "PARAMETER_NUMBER", 0,
                "FIELD_SOURCE", "RDB$10",
                "FIELD_TYPE", 7,
                "FIELD_SUB_TYPE", 0,
                "FIELD_SCALE", 0,
                "FIELD_LENGTH", 2
            )
        );

        ObjectSource source = agent.getObjectSource("ignored-schema", "Mix\"Case", "PROCEDURE");

        Assertions.assertEquals(List.of(EXPECTED_PROCEDURE_SOURCE_SQL), sql);
        Assertions.assertEquals(List.of("1=Mix\"Case"), parameters);
        Assertions.assertFalse(EXPECTED_PROCEDURE_SOURCE_SQL.contains("Mix\"Case"));
        Assertions.assertEquals(
            "CREATE OR ALTER PROCEDURE \"Mix\"\"Case\" (\n"
                + "  \"Arg\"\"Name\" SMALLINT\n"
                + ")\n"
                + "AS\n"
                + "BEGIN\nEND\n",
            source.getSource()
        );
    }

    @Test
    void mapsExactNumericLegacyAndFirebirdFourTypes() {
        FirebirdAgent agent = agentWithRows(
            new ArrayList<>(),
            new ArrayList<>(),
            row(
                "PROCEDURE_SOURCE", "BEGIN\nEND",
                "PARAMETER_NAME", "N_SMALL",
                "PARAMETER_TYPE", 0,
                "FIELD_SOURCE", "RDB$11",
                "FIELD_TYPE", 7,
                "FIELD_SUB_TYPE", 1,
                "FIELD_PRECISION", 4,
                "FIELD_SCALE", -2,
                "FIELD_LENGTH", 2
            ),
            row(
                "PARAMETER_NAME", "N_LEGACY",
                "PARAMETER_TYPE", 0,
                "FIELD_SOURCE", "RDB$12",
                "FIELD_TYPE", 8,
                "FIELD_SUB_TYPE", 0,
                "FIELD_PRECISION", 9,
                "FIELD_SCALE", -2,
                "FIELD_LENGTH", 4
            ),
            row(
                "PARAMETER_NAME", "D_FLOAT_VALUE",
                "PARAMETER_TYPE", 0,
                "FIELD_SOURCE", "RDB$13",
                "FIELD_TYPE", 11,
                "FIELD_SUB_TYPE", 0,
                "FIELD_LENGTH", 8
            ),
            row(
                "PARAMETER_NAME", "DEC16_VALUE",
                "PARAMETER_TYPE", 0,
                "FIELD_SOURCE", "RDB$14",
                "FIELD_TYPE", 24,
                "FIELD_SUB_TYPE", 0,
                "FIELD_LENGTH", 8
            ),
            row(
                "PARAMETER_NAME", "DEC34_VALUE",
                "PARAMETER_TYPE", 0,
                "FIELD_SOURCE", "RDB$15",
                "FIELD_TYPE", 25,
                "FIELD_SUB_TYPE", 0,
                "FIELD_LENGTH", 16
            ),
            row(
                "PARAMETER_NAME", "BINARY_VALUE",
                "PARAMETER_TYPE", 0,
                "FIELD_SOURCE", "RDB$16",
                "FIELD_TYPE", 14,
                "FIELD_SUB_TYPE", 1,
                "FIELD_LENGTH", 4
            ),
            row(
                "PARAMETER_NAME", "VARBINARY_VALUE",
                "PARAMETER_TYPE", 0,
                "FIELD_SOURCE", "RDB$17",
                "FIELD_TYPE", 37,
                "FIELD_SUB_TYPE", 1,
                "FIELD_LENGTH", 8
            )
        );

        ObjectSource source = agent.getObjectSource(null, "P_TYPES", "PROCEDURE");

        Assertions.assertEquals(
            "CREATE OR ALTER PROCEDURE \"P_TYPES\" (\n"
                + "  \"N_SMALL\" NUMERIC(4,2),\n"
                + "  \"N_LEGACY\" NUMERIC(9,2),\n"
                + "  \"D_FLOAT_VALUE\" DOUBLE PRECISION,\n"
                + "  \"DEC16_VALUE\" DECFLOAT(16),\n"
                + "  \"DEC34_VALUE\" DECFLOAT(34),\n"
                + "  \"BINARY_VALUE\" BINARY(4),\n"
                + "  \"VARBINARY_VALUE\" VARBINARY(8)\n"
                + ")\n"
                + "AS\n"
                + "BEGIN\nEND\n",
            source.getSource()
        );
    }

    @Test
    void returnsEmptySourceWhenRoutineIsMissing() {
        FirebirdAgent agent = agentWithRows(new ArrayList<>(), new ArrayList<>());

        ObjectSource source = agent.getObjectSource(null, "MISSING_PROCEDURE", "PROCEDURE");

        Assertions.assertEquals("", source.getSource());
        Assertions.assertFalse(source.isEditable());
    }

    @Test
    void returnsEmptySourceWhenStoredBodyIsNull() {
        FirebirdAgent agent = agentWithRows(
            new ArrayList<>(),
            new ArrayList<>(),
            row("PROCEDURE_SOURCE", null, "PARAMETER_NAME", null)
        );

        ObjectSource source = agent.getObjectSource(null, "EXTERNAL_PROCEDURE", "PROCEDURE");

        Assertions.assertEquals("", source.getSource());
    }

    @Test
    void propagatesMetadataQueryErrors() {
        FirebirdAgent agent = new FirebirdAgent();
        SQLException failure = new SQLException("metadata unavailable", "HY000");
        TestSupport.setPrivateConnection(agent, proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                throw failure;
            }
            return defaultValue(method.getReturnType());
        }));

        RuntimeException error = Assertions.assertThrows(
            RuntimeException.class,
            () -> agent.getObjectSource(null, "P_6141", "PROCEDURE")
        );

        Assertions.assertSame(failure, error.getCause());
    }

    @Test
    void rejectsUnsupportedObjectTypesBeforeQuerying() {
        FirebirdAgent agent = new FirebirdAgent();

        IllegalArgumentException error = Assertions.assertThrows(
            IllegalArgumentException.class,
            () -> agent.getObjectSource(null, "P_6141", "VIEW")
        );

        Assertions.assertEquals("Unsupported object type: VIEW", error.getMessage());
    }

    @SafeVarargs
    private static FirebirdAgent agentWithRows(
        List<String> sql,
        List<String> parameters,
        Map<String, Object>... rows
    ) {
        ResultSet resultSet = resultSet(List.of(rows));
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("setString".equals(method.getName())) {
                parameters.add(args[0] + "=" + args[1]);
                return null;
            }
            if ("executeQuery".equals(method.getName())) {
                return resultSet;
            }
            return defaultValue(method.getReturnType());
        });
        Connection connection = proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
        FirebirdAgent agent = new FirebirdAgent();
        TestSupport.setPrivateConnection(agent, connection);
        return agent;
    }

    private static ResultSet resultSet(List<Map<String, Object>> rows) {
        int[] index = {-1};
        boolean[] wasNull = {false};
        return proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) {
                index[0] += 1;
                return index[0] < rows.size();
            }
            if ("getString".equals(method.getName())) {
                Object value = rows.get(index[0]).get(String.valueOf(args[0]));
                wasNull[0] = value == null;
                return value == null ? null : String.valueOf(value);
            }
            if ("getInt".equals(method.getName())) {
                Object value = rows.get(index[0]).get(String.valueOf(args[0]));
                wasNull[0] = value == null;
                return value == null ? 0 : ((Number) value).intValue();
            }
            if ("wasNull".equals(method.getName())) {
                return wasNull[0];
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Map<String, Object> row(Object... values) {
        Map<String, Object> row = new HashMap<>();
        for (int index = 0; index < values.length; index += 2) {
            row.put((String) values[index], values[index + 1]);
        }
        return row;
    }

    private static String procedureBody() {
        return """
            DECLARE VARIABLE V_NOTE VARCHAR(20);
            BEGIN
              O_ID = P_ID;
              O_TEXT = P_LABEL || ':' || P_DOM;
              SUSPEND;
            END""";
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) return false;
        if (type == Byte.TYPE) return (byte) 0;
        if (type == Short.TYPE) return (short) 0;
        if (type == Integer.TYPE) return 0;
        if (type == Long.TYPE) return 0L;
        if (type == Float.TYPE) return 0f;
        if (type == Double.TYPE) return 0d;
        if (type == Character.TYPE) return (char) 0;
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}

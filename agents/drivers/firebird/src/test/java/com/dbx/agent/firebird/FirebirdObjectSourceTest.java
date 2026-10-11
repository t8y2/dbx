package com.dbx.agent.firebird;

import com.dbx.agent.ObjectSource;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class FirebirdObjectSourceTest {
    @Test
    void generatorSourceNeverReadsOrIncrementsCurrentValue() throws Exception {
        List<String> calls = new ArrayList<>();
        ObjectSource source = FirebirdObjectSource.read(connection(calls, "G\"ID", 10L, 5L), "", "G\"ID", "SEQUENCE", value -> value);
        assertEquals("CREATE SEQUENCE \"G\"\"ID\" START WITH 10 INCREMENT BY 5;", source.getSource());
        assertFalse(source.isEditable());
        assertEquals("G\"ID", calls.get(1));
        assertFalse(calls.get(0).contains("GEN_ID"));
    }

    @Test
    void externalFunctionsShowModuleEntrypointAndEngineWithoutCallingUdf() throws Exception {
        List<String> calls = new ArrayList<>();
        ObjectSource source = FirebirdObjectSource.read(connection(calls, null, "FreeAdhocUDF", "f_abs", null), "", "F_ABS", "FUNCTION", value -> value);
        assertTrue(source.getSource().contains("Module: FreeAdhocUDF"));
        assertTrue(source.getSource().contains("Entry point: f_abs"));
        assertTrue(calls.get(0).startsWith("SELECT "));
        assertFalse(source.isEditable());
    }

    @Test
    void packagedFunctionsUseQualifiedCatalogIdentityAndDecodeOnlyBody() throws Exception {
        List<String> calls = new ArrayList<>();
        ObjectSource source = FirebirdObjectSource.read(connection(calls, "²Ý¸å", null, null, null), "", "MYUDR2.FN", "FUNCTION",
            value -> LegacyTextDecoder.decode(value, java.nio.charset.Charset.forName("GBK")));
        assertEquals("MYUDR2.FN", calls.get(1));
        assertTrue(calls.get(0).contains("RDB$PACKAGE_NAME"));
        assertTrue(source.getSource().contains("草稿"));
    }

    @Test
    void tableTriggerSourceBuildsStandardCreateOrAlterTriggerDdl() throws Exception {
        List<String> calls = new ArrayList<>();
        ObjectSource source = FirebirdObjectSource.read(
            connection(calls, "AS\nBEGIN\n  NEW.ID = 1;\nEND", "ORDERS", 1, 0, 0),
            "", "TR_ORDERS_BI", "TRIGGER", value -> value
        );
        assertEquals(
            "CREATE OR ALTER TRIGGER \"TR_ORDERS_BI\" FOR \"ORDERS\" ACTIVE\nBEFORE INSERT\nAS\nBEGIN\n  NEW.ID = 1;\nEND",
            source.getSource()
        );
        assertEquals("TR_ORDERS_BI", source.getName());
        assertEquals("TRIGGER", source.getObject_type());
    }

    @Test
    void databaseTriggerSourceFormatsEventAndTiming() throws Exception {
        List<String> calls = new ArrayList<>();
        ObjectSource source = FirebirdObjectSource.read(
            connection(calls, "BEGIN\n  EXECUTE PROCEDURE LOG_CONN;\nEND", null, 8192, 1, 1),
            "", "TR_CONN", "TRIGGER", value -> value
        );
        assertEquals(
            "CREATE OR ALTER TRIGGER \"TR_CONN\" INACTIVE\nON CONNECT POSITION 1\nAS\nBEGIN\n  EXECUTE PROCEDURE LOG_CONN;\nEND",
            source.getSource()
        );
    }

    private static Connection connection(List<String> calls, Object... values) {
        ResultSet result = (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[] {ResultSet.class},
            new java.lang.reflect.InvocationHandler() {
                boolean first = true;
                public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> { boolean value = first; first = false; yield value; }
                        case "getString" -> { Object value = values[(Integer) args[0] - 1]; yield value == null ? null : value.toString(); }
                        case "getInt" -> ((Number) values[(Integer) args[0] - 1]).intValue();
                        case "getLong" -> ((Number) values[(Integer) args[0] - 1]).longValue();
                        case "close" -> null;
                        default -> throw new UnsupportedOperationException(method.getName());
                    };
                }
            });
        PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(), new Class<?>[] {PreparedStatement.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "setString" -> { calls.add((String) args[1]); yield null; }
                case "executeQuery" -> result;
                case "close" -> null;
                default -> throw new UnsupportedOperationException(method.getName());
            });
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if (method.getName().equals("getMetaData")) {
                    return Proxy.newProxyInstance(java.sql.DatabaseMetaData.class.getClassLoader(), new Class<?>[] {java.sql.DatabaseMetaData.class},
                        (metadata, operation, arguments) -> {
                            if (operation.getName().equals("getDatabaseMajorVersion")) return 5;
                            throw new UnsupportedOperationException(operation.getName());
                        });
                }
                if (method.getName().equals("prepareStatement")) { calls.add((String) args[0]); return statement; }
                throw new UnsupportedOperationException(method.getName());
            });
    }
}

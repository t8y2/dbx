package com.dbx.agent.sundb;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * SUNDB 服务端只接受自家语法（{@code SHOW DATABASES} 会以 16062 报错），
 * 因此元数据必须交给厂商驱动的 {@link DatabaseMetaData}（内部查询
 * {@code INFORMATION_SCHEMA.DBC_*} 视图），而不是手写 MySQL 语句。
 */
class SundbAgentMetadataTest {
    @Test
    void loadsDatabasesAndSchemasFromDriverMetadata() {
        List<String> statements = new ArrayList<>();
        List<String> metadataRequests = new ArrayList<>();
        SundbAgent agent = new SundbAgent();
        TestSupport.setPrivateConnection(
            agent,
            connection(statements, metadata(emptyRows(), schemas("APP", "PUBLIC"), emptyRows(), emptyRows(), metadataRequests))
        );
        setConfiguredDatabase(agent, "SUNDB");

        List<String> databases = agent.listDatabases().stream().map(DatabaseInfo::getName).toList();
        List<String> schemas = agent.listSchemas();

        // 驱动的 getCatalogs() 是 WHERE 1=0 的占位查询，数据库名来自连接上的 database。
        Assertions.assertEquals(List.of("SUNDB"), databases);
        Assertions.assertEquals(List.of("APP", "PUBLIC"), schemas);
        Assertions.assertEquals(List.of("getSchemas:SUNDB"), metadataRequests);
        Assertions.assertTrue(statements.isEmpty(), "元数据不应执行手写 SQL: " + statements);
    }

    @Test
    void listsTablesThroughDriverMetadataWithSunDbTableTypes() {
        List<String> statements = new ArrayList<>();
        List<String> metadataRequests = new ArrayList<>();
        SundbAgent agent = new SundbAgent();
        TestSupport.setPrivateConnection(
            agent,
            connection(
                statements,
                metadata(
                    emptyRows(),
                    emptyRows(),
                    rows(new String[] {"TABLE_TYPE"}, new Object[][] {{"BASE TABLE"}, {"VIEW"}}),
                    rows(
                        new String[] {"TABLE_NAME", "TABLE_TYPE", "REMARKS"},
                        new Object[][] {{"ITEMS", "BASE TABLE", null}, {"ITEM_VIEW", "VIEW", "视图"}}
                    ),
                    metadataRequests
                )
            )
        );
        setConfiguredDatabase(agent, "SUNDB");

        List<TableInfo> tables = agent.listTables("APP");

        // 只有 DBC_TABLE_TYPE 真实支持的取值才会传给驱动。
        Assertions.assertEquals(List.of("getTables:BASE TABLE", "getTables:VIEW"), metadataRequests);
        Assertions.assertEquals(List.of("ITEMS", "ITEM_VIEW"), tables.stream().map(TableInfo::getName).toList());
        Assertions.assertEquals(List.of("TABLE", "VIEW"), tables.stream().map(TableInfo::getTable_type).toList());
        Assertions.assertEquals("视图", tables.get(1).getComment());
        Assertions.assertTrue(statements.isEmpty(), "元数据不应执行手写 SQL: " + statements);
    }

    @Test
    void retriesSchemasWithoutTheCatalogFilterThatMatchesNoSunDbRows() {
        // 驱动的 getCatalog() 返回 null，所以 schema 查询会用连接上的 database 作为 catalog 过滤；
        // SUNDB 的 CATALOG_NAME 与该值不一致时会返回空集，此时必须退回不带 catalog 的 getSchemas()，
        // 否则对象树会停在空的 schema 节点上（库下的表永远加载不出来）。
        List<String> statements = new ArrayList<>();
        List<String> metadataRequests = new ArrayList<>();
        SundbAgent agent = new SundbAgent();
        DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getCatalogs":
                    return emptyRows();
                case "getSchemas":
                    metadataRequests.add("getSchemas:" + args[0]);
                    return args[0] == null ? schemas("APP", "PUBLIC") : emptyRows();
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        TestSupport.setPrivateConnection(agent, connection(statements, metadata));
        setConfiguredDatabase(agent, "SUNDB");

        List<String> schemas = agent.listSchemas();

        Assertions.assertEquals(List.of("getSchemas:SUNDB", "getSchemas:null"), metadataRequests);
        Assertions.assertEquals(List.of("APP", "PUBLIC"), schemas);
        Assertions.assertTrue(statements.isEmpty(), "元数据不应执行手写 SQL: " + statements);
    }

    @Test
    void switchesSchemaWithSetSchemaInsteadOfMysqlUse() {
        SundbAgent agent = new SundbAgent();
        TestSupport.setPrivateConnection(agent, connection(new ArrayList<>(), metadata(
            emptyRows(), emptyRows(), emptyRows(), emptyRows(), new ArrayList<>()
        )));

        Assertions.assertEquals("SET SCHEMA \"APP\"", agent.setSchemaSQL("APP"));
    }

    @Test
    void buildsSunDbJdbcUrlFromProfileTemplate() {
        Assertions.assertEquals("csii.sundb.jdbc.SundbDriver", SundbAgent.SUNDB_PROFILE.getDriverClass());
        Assertions.assertEquals(22581, SundbAgent.SUNDB_PROFILE.getDefaultPort());

        ConnectParams params = new ConnectParams();
        params.setHost("10.0.0.1");
        params.setPort(22581);
        params.setDatabase("SUNDB");

        Assertions.assertEquals("jdbc:sundb://10.0.0.1:22581/SUNDB", SundbAgent.SUNDB_PROFILE.buildUrl(params));
    }

    private static void setConfiguredDatabase(SundbAgent agent, String database) {
        try {
            Field field = ConfiguredJdbcAgent.class.getDeclaredField("configuredDatabase");
            field.setAccessible(true);
            field.set(agent, database);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private static DatabaseMetaData metadata(
        ResultSet catalogs,
        ResultSet schemas,
        ResultSet tableTypes,
        ResultSet tables,
        List<String> metadataRequests
    ) {
        return proxy(DatabaseMetaData.class, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getCatalogs":
                    return catalogs;
                case "getSchemas":
                    metadataRequests.add("getSchemas:" + args[0]);
                    return schemas;
                case "getTableTypes":
                    return tableTypes;
                case "getTables":
                    for (Object type : (String[]) args[3]) {
                        metadataRequests.add("getTables:" + type);
                    }
                    return tables;
                case "getIdentifierQuoteString":
                    return "\"";
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Connection connection(List<String> statements, DatabaseMetaData metadata) {
        return proxy(Connection.class, (proxy, method, args) -> {
            switch (method.getName()) {
                case "createStatement":
                    return statement(statements);
                case "prepareStatement":
                    statements.add((String) args[0]);
                    return preparedStatement(statements);
                case "getMetaData":
                    return metadata;
                case "getAutoCommit":
                    return true;
                case "isClosed":
                    return false;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Statement statement(List<String> statements) {
        ResultSet resultSet = emptyRows();
        return proxy(Statement.class, (proxy, method, args) -> {
            switch (method.getName()) {
                case "execute":
                    statements.add((String) args[0]);
                    return false;
                case "executeQuery":
                    statements.add((String) args[0]);
                    return resultSet;
                case "getResultSet":
                    return resultSet;
                case "getUpdateCount":
                    return 0;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static PreparedStatement preparedStatement(List<String> statements) {
        ResultSet resultSet = emptyRows();
        return proxy(PreparedStatement.class, (proxy, method, args) -> {
            switch (method.getName()) {
                case "executeQuery":
                    return resultSet;
                case "getResultSet":
                    return resultSet;
                case "getUpdateCount":
                    return 0;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet schemas(String... names) {
        Object[][] data = new Object[names.length][];
        for (int i = 0; i < names.length; i++) {
            data[i] = new Object[] {names[i]};
        }
        return rows(new String[] {"TABLE_SCHEM"}, data);
    }

    private static ResultSet rows(String[] columns, Object[][] data) {
        final int[] index = {-1};
        return proxy(ResultSet.class, (proxy, method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0]++;
                    return index[0] < data.length;
                case "getString": {
                    Object cell = cell(data[index[0]], columns, args[0]);
                    return cell == null ? null : cell.toString();
                }
                case "wasNull":
                    return false;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Object cell(Object[] row, String[] columns, Object selector) {
        int position = selector instanceof Number
            ? ((Number) selector).intValue() - 1
            : Arrays.asList(columns).indexOf((String) selector);
        return row[position];
    }

    private static ResultSet emptyRows() {
        return rows(new String[0], new Object[0][]);
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) {
            return false;
        }
        if (Byte.TYPE.equals(type)) {
            return (byte) 0;
        }
        if (Short.TYPE.equals(type)) {
            return (short) 0;
        }
        if (Integer.TYPE.equals(type)) {
            return 0;
        }
        if (Long.TYPE.equals(type)) {
            return 0L;
        }
        if (Float.TYPE.equals(type)) {
            return 0f;
        }
        if (Double.TYPE.equals(type)) {
            return 0.0d;
        }
        if (Character.TYPE.equals(type)) {
            return '\0';
        }
        return null;
    }
}

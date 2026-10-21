package com.dbx.agent.gbase8c;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
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
 * GBase 8c 的元数据行为契约。
 *
 * <p>三条断言各自对应一次真机实测，注释里写了依据，改动前请先看
 * {@code docs/pips/plans/2026-10-16-gbase8c-support.md} 的附录 A。
 */
class Gbase8cAgentMetadataTest {
    /** 实测 getSchemas() 返回 19 个，其中 17 个是 openGauss/GaussDB 内部 schema。 */
    private static final List<String> VENDOR_SCHEMAS = List.of(
        "auditadmin", "audituser", "blockchain", "coverage", "cstore", "db4ai",
        "dbe_perf", "dbe_pldebugger", "dbe_pldeveloper", "dbe_sql_util",
        "information_schema", "pg_catalog", "pkg_service", "securityadmin",
        "snapshot", "sqladvisor", "sysadmin", "dbx_smoke", "public"
    );

    /** 实测 getTableTypes() 里含非标准项，其中 INDEX 会让索引变成「表」。 */
    private static final List<String> VENDOR_TABLE_TYPES = List.of(
        "FOREIGN TABLE", "INDEX", "LOCAL TEMPORARY", "SEQUENCE", "SYSTEM INDEX",
        "SYSTEM TABLE", "SYSTEM TOAST INDEX", "SYSTEM TOAST TABLE", "SYSTEM VIEW",
        "TABLE", "TEMPORARY TABLE", "TYPE", "VIEW"
    );

    @Test
    void listsEveryDatabaseFromPgDatabaseInsteadOfTheSingleGetCatalogsRow() {
        // 实测 getCatalogs() 只返回当前连接的库（1 行），而服务器上有 7 个库。
        List<String> statements = new ArrayList<>();
        Gbase8cAgent agent = new Gbase8cAgent();
        TestSupport.setPrivateConnection(
            agent,
            connection(
                statements,
                metadata(emptyRows(), emptyRows(), emptyRows(), emptyRows(), new ArrayList<>()),
                rows(new String[] {"datname"}, new Object[][] {
                    {"dbx_a"}, {"dbx_b"}, {"dbx_c"}, {"dbx_pg"}, {"postgres"}
                }),
                "dbx_pg",
                "public"
            )
        );
        setConfiguredDatabase(agent, "dbx_pg");

        List<String> databases = agent.listDatabases().stream().map(DatabaseInfo::getName).toList();

        Assertions.assertEquals(
            List.of("dbx_a", "dbx_b", "dbx_c", "dbx_pg", "postgres"),
            databases
        );
        Assertions.assertEquals(List.of(Gbase8cAgent.LIST_DATABASES_SQL), statements);
    }

    @Test
    void hidesOpenGaussSystemSchemasFromTheSchemaList() {
        List<String> metadataRequests = new ArrayList<>();
        Gbase8cAgent agent = new Gbase8cAgent();
        TestSupport.setPrivateConnection(
            agent,
            connection(
                new ArrayList<>(),
                metadata(emptyRows(), schemas(VENDOR_SCHEMAS), emptyRows(), emptyRows(), metadataRequests),
                emptyRows(),
                "dbx_pg",
                "public"
            )
        );
        setConfiguredDatabase(agent, "dbx_pg");

        List<String> visible = agent.listSchemas();

        Assertions.assertEquals(List.of("dbx_smoke", "public"), visible);
        // 驱动拿到的 catalog 是连接上的库名；回退路径不应被触发。
        Assertions.assertEquals(List.of("getSchemas:dbx_pg"), metadataRequests);
    }

    @Test
    void asksTheDriverOnlyForTablesAndViews() {
        // 默认白名单含 SYSTEM TABLE / SYSTEM VIEW，实测跨 schema 会多出 331 个系统对象。
        List<String> requestedTypes = new ArrayList<>();
        List<String> statements = new ArrayList<>();
        Gbase8cAgent agent = new Gbase8cAgent();
        TestSupport.setPrivateConnection(
            agent,
            connection(
                statements,
                metadata(
                    emptyRows(),
                    emptyRows(),
                    rows(new String[] {"TABLE_TYPE"}, toRows(VENDOR_TABLE_TYPES)),
                    rows(
                        new String[] {"TABLE_NAME", "TABLE_TYPE", "REMARKS"},
                        new Object[][] {{"t1", "TABLE", "smoke table"}, {"v1", "VIEW", null}}
                    ),
                    new ArrayList<>(),
                    requestedTypes
                ),
                emptyRows(),
                "dbx_pg",
                "public"
            )
        );
        setConfiguredDatabase(agent, "dbx_pg");

        List<TableInfo> tables = agent.listTables("dbx_smoke");

        Assertions.assertEquals(List.of("TABLE,VIEW"), requestedTypes);
        Assertions.assertEquals(List.of("t1", "v1"), tables.stream().map(TableInfo::getName).toList());
        Assertions.assertEquals("smoke table", tables.get(0).getComment());
    }

    @Test
    void switchesSchemaWithSetSearchPath() {
        Gbase8cAgent agent = new Gbase8cAgent();
        TestSupport.setPrivateConnection(
            agent,
            connection(
                new ArrayList<>(),
                metadata(emptyRows(), emptyRows(), emptyRows(), emptyRows(), new ArrayList<>()),
                emptyRows(),
                "dbx_pg",
                "public"
            )
        );

        Assertions.assertEquals("SET search_path TO \"dbx_smoke\"", agent.setSchemaSQL("dbx_smoke"));
    }

    @Test
    void declaresTheVendorJdbcProfileAndExcludesEverySystemSchema() {
        Assertions.assertEquals("com.gbase8c.Driver", Gbase8cAgent.GBASE8C_PROFILE.getDriverClass());
        Assertions.assertEquals(5432, Gbase8cAgent.GBASE8C_PROFILE.getDefaultPort());
        Assertions.assertEquals(
            "jdbc:gbase8c://{host}:{port}/{database}",
            Gbase8cAgent.GBASE8C_PROFILE.getUrlTemplate()
        );
        // 实测四种兼容模式的 getIdentifierQuoteString() 都是双引号，且双引号确实可用。
        Assertions.assertEquals("\"", Gbase8cAgent.GBASE8C_PROFILE.getIdentifierQuote());
        Assertions.assertEquals("SET search_path TO", Gbase8cAgent.GBASE8C_PROFILE.getSchemaSwitchPrefix());
        Assertions.assertFalse(Gbase8cAgent.GBASE8C_PROFILE.getSkipExecutionContext());
        Assertions.assertFalse(Gbase8cAgent.GBASE8C_PROFILE.getNativeTableDdlSupported());
        Assertions.assertFalse(Gbase8cAgent.GBASE8C_PROFILE.getObjectSourceSupported());
        Assertions.assertFalse(Gbase8cAgent.GBASE8C_PROFILE.getTriggersSupported());
        // 驱动行的 TABLE_CAT=null，schema 查询需要 catalog 回退兜底。
        Assertions.assertTrue(Gbase8cAgent.GBASE8C_PROFILE.getCatalogFallbackEnabled());
        Assertions.assertEquals(List.of("TABLE", "VIEW"), Gbase8cAgent.GBASE8C_PROFILE.getTableTypes());
        Assertions.assertEquals(Gbase8cAgent.GBASE8C_EXCLUDED_SCHEMAS, Gbase8cAgent.GBASE8C_PROFILE.getExcludedSchemas());
        Assertions.assertTrue(Gbase8cAgent.GBASE8C_EXCLUDED_SCHEMAS.contains("DBE_PERF"));
        Assertions.assertTrue(Gbase8cAgent.GBASE8C_EXCLUDED_SCHEMAS.contains("PG_CATALOG"));
        Assertions.assertEquals(17, Gbase8cAgent.GBASE8C_EXCLUDED_SCHEMAS.size());

        ConnectParams params = new ConnectParams();
        params.setHost("10.1.2.3");
        params.setPort(5432);
        params.setDatabase("dbx_pg");

        Assertions.assertEquals(
            "jdbc:gbase8c://10.1.2.3:5432/dbx_pg",
            Gbase8cAgent.GBASE8C_PROFILE.buildUrl(params)
        );
    }

    private static void setConfiguredDatabase(Gbase8cAgent agent, String database) {
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
        return metadata(catalogs, schemas, tableTypes, tables, metadataRequests, new ArrayList<>());
    }

    private static DatabaseMetaData metadata(
        ResultSet catalogs,
        ResultSet schemas,
        ResultSet tableTypes,
        ResultSet tables,
        List<String> metadataRequests,
        List<String> requestedTypes
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
                    requestedTypes.add(String.join(",", (String[]) args[3]));
                    return tables;
                case "getIdentifierQuoteString":
                    // 厂商驱动在 A/B/C/PG 四种兼容模式下都返回这个值。
                    return "\"";
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Connection connection(
        List<String> statements,
        DatabaseMetaData metadata,
        ResultSet preparedRows,
        String catalog,
        String schema
    ) {
        return proxy(Connection.class, (proxy, method, args) -> {
            switch (method.getName()) {
                case "createStatement":
                    return statement(statements);
                case "prepareStatement":
                    statements.add((String) args[0]);
                    return preparedStatement(preparedRows);
                case "getMetaData":
                    return metadata;
                case "getCatalog":
                    return catalog;
                case "getSchema":
                    return schema;
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

    private static PreparedStatement preparedStatement(ResultSet resultSet) {
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

    private static ResultSet schemas(List<String> names) {
        Object[][] data = new Object[names.size()][];
        for (int i = 0; i < names.size(); i++) {
            data[i] = new Object[] {names.get(i)};
        }
        return rows(new String[] {"TABLE_SCHEM"}, data);
    }

    private static Object[][] toRows(List<String> values) {
        Object[][] data = new Object[values.size()][];
        for (int i = 0; i < values.size(); i++) {
            data[i] = new Object[] {values.get(i)};
        }
        return data;
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

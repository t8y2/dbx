package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StandardJdbcMetadataTest {
    private final JdbcAgentProfile profile = new JdbcAgentProfile(
        "example.Driver",
        "jdbc:example://{host}:{port}/{database}",
        0,
        false,
        Collections.singleton("SYS"),
        Arrays.asList("TABLE", "VIEW", "BASE TABLE")
    );

    @Test
    void listsSchemasWithFilteringAndStableOrdering() {
        Connection conn = connection(
            rows(row("TABLE_SCHEM", "APP"), row("TABLE_SCHEM", "SYS"), row("TABLE_SCHEM", "PUBLIC")),
            rows(),
            rows(),
            rows(),
            rows(),
            rows()
        );

        assertEquals(Arrays.asList("APP", "PUBLIC"), StandardJdbcMetadata.INSTANCE.listSchemas(conn, profile));
    }

    @Test
    void listsSchemasWhenConnectionGetSchemaIsUnsupported() {
        Connection conn = connection(
            rows(row("TABLE_SCHEM", "APP"), row("TABLE_SCHEM", "PUBLIC")),
            rows(),
            rows(),
            rows(),
            rows(),
            rows(),
            true
        );

        assertEquals(Arrays.asList("APP", "PUBLIC"), StandardJdbcMetadata.INSTANCE.listSchemas(conn, profile));
    }

    @Test
    void listsSchemasWhenConnectionGetSchemaThrowsAbstractMethodError() {
        Connection conn = connection(
            rows(row("TABLE_SCHEM", "APP"), row("TABLE_SCHEM", "PUBLIC")),
            rows(),
            rows(),
            rows(),
            rows(),
            rows(),
            UnsupportedSchemaCall.ABSTRACT_METHOD_ERROR
        );

        assertEquals(Arrays.asList("APP", "PUBLIC"), StandardJdbcMetadata.INSTANCE.listSchemas(conn, profile));
    }

    @Test
    void listsSchemasWithEmptyResultWhenDriverSchemaMetadataIsUnsupported() {
        Connection conn = connection(
            rows(),
            rows(),
            rows(),
            rows(),
            rows(),
            rows(),
            UnsupportedSchemaCall.METADATA_AND_CONNECTION_ABSTRACT_METHOD_ERROR
        );

        assertEquals(Collections.emptyList(), StandardJdbcMetadata.INSTANCE.listSchemas(conn, profile));
    }

    @Test
    void listsTablesWithNormalizedTypesAndStableOrdering() {
        Connection conn = connection(
            rows(),
            rows(row("TABLE_NAME", "ZETA", "TABLE_TYPE", "BASE TABLE", "REMARKS", "last"),
                row("TABLE_NAME", "ALPHA", "TABLE_TYPE", "VIEW", "REMARKS", "first")),
            rows(),
            rows(),
            rows(),
            rows()
        );

        List<TableInfo> tables = StandardJdbcMetadata.INSTANCE.listTables(conn, profile, "", "APP");

        assertEquals("ALPHA", tables.get(0).getName());
        assertEquals("VIEW", tables.get(0).getTable_type());
        assertEquals("ZETA", tables.get(1).getName());
        assertEquals("TABLE", tables.get(1).getTable_type());
    }

    @Test
    void listsProceduresAndFunctionsFromJdbcRoutineMetadata() {
        Connection conn = routineConnection(
            rows(
                row("PROCEDURE_NAME", "PROCESS_ORDER", "REMARKS", "processes an order"),
                row("PROCEDURE_NAME", "SHARED_ROUTINE", "REMARKS", null)
            ),
            rows(
                row("FUNCTION_NAME", "CALCULATE_TOTAL", "REMARKS", "calculates a total"),
                row("FUNCTION_NAME", "SHARED_ROUTINE", "REMARKS", null)
            )
        );
        MetadataListConstraints constraints =
            new MetadataListConstraints(null, null, null, Collections.singletonList("PROCEDURE"));

        List<ObjectInfo> objects = StandardJdbcMetadata.INSTANCE.listObjects(conn, profile, "", "APP", constraints);

        assertEquals(2, objects.size());
        assertEquals("PROCESS_ORDER", objects.get(0).getName());
        assertEquals("PROCEDURE", objects.get(0).getObject_type());
        assertEquals("SHARED_ROUTINE", objects.get(1).getName());
        assertEquals("PROCEDURE", objects.get(1).getObject_type());
    }

    @Test
    void listsDataTypesFromJdbcTypeInfo() {
        Connection conn = connection(
            rows(),
            rows(),
            rows(),
            rows(),
            rows(),
            rows(),
            UnsupportedSchemaCall.NONE,
            null,
            null,
            null,
            null,
            rows(row("TYPE_NAME", "INTEGER"), row("TYPE_NAME", "VARCHAR"), row("TYPE_NAME", "integer"))
        );

        assertEquals(Arrays.asList("INTEGER", "VARCHAR"), StandardJdbcMetadata.INSTANCE.listDataTypes(conn));
    }

    @Test
    void listTablesUsesDriverTableTypesWithinProfileAllowList() {
        AtomicReference<String[]> capturedTypes = new AtomicReference<>();
        Connection conn = connection(
            rows(),
            rows(row("TABLE_NAME", "ORDERS", "TABLE_TYPE", "TABLE", "REMARKS", null)),
            rows(),
            rows(),
            rows(),
            rows(),
            rows(
                row("TABLE_TYPE", "TABLE"),
                row("TABLE_TYPE", "LOCAL TEMPORARY"),
                row("TABLE_TYPE", "BASE TABLE")
            ),
            capturedTypes
        );

        StandardJdbcMetadata.INSTANCE.listTables(conn, profile, "", "APP");

        assertEquals(Arrays.asList("TABLE", "BASE TABLE"), Arrays.asList(capturedTypes.get()));
    }

    @Test
    void listTablesAllowsHanaColumnAndRowTables() {
        JdbcAgentProfile hanaProfile = new JdbcAgentProfile(
            "com.sap.db.jdbc.Driver",
            "jdbc:sap://{host}:{port}/?databaseName={database}",
            30015,
            false,
            Collections.emptySet(),
            Arrays.asList("COLUMN TABLE", "ROW TABLE", "TABLE", "VIEW")
        );
        AtomicReference<String[]> capturedTypes = new AtomicReference<>();
        Connection conn = connection(
            rows(),
            rows(
                row("TABLE_NAME", "ORDERS", "TABLE_TYPE", "COLUMN TABLE", "REMARKS", null),
                row("TABLE_NAME", "AUDIT_LOG", "TABLE_TYPE", "ROW TABLE", "REMARKS", null),
                row("TABLE_NAME", "ACTIVE_ORDERS", "TABLE_TYPE", "VIEW", "REMARKS", null)
            ),
            rows(),
            rows(),
            rows(),
            rows(),
            rows(
                row("TABLE_TYPE", "COLUMN TABLE"),
                row("TABLE_TYPE", "ROW TABLE"),
                row("TABLE_TYPE", "VIEW")
            ),
            capturedTypes
        );

        List<TableInfo> tables = StandardJdbcMetadata.INSTANCE.listTables(conn, hanaProfile, "", "APP");

        assertEquals(Arrays.asList("COLUMN TABLE", "ROW TABLE", "VIEW"), Arrays.asList(capturedTypes.get()));
        assertEquals(Arrays.asList("ACTIVE_ORDERS", "AUDIT_LOG", "ORDERS"), Arrays.asList(
            tables.get(0).getName(),
            tables.get(1).getName(),
            tables.get(2).getName()
        ));
        assertEquals("VIEW", tables.get(0).getTable_type());
        assertEquals("TABLE", tables.get(1).getTable_type());
        assertEquals("TABLE", tables.get(2).getTable_type());
    }

    @Test
    void listTablesEscapesUnderscoreInHanaSysSchema() {
        // HANA 的 _SYS_RT 等 schema 名含下划线，JDBC schemaPattern 把 _ 当作通配符，
        // 若不转义会误匹配 _xSYSxRT 等其他 schema。HANA 驱动 getSearchStringEscape() 返回 "\\"。
        AtomicReference<Object[]> capturedArgs = new AtomicReference<>();
        Connection conn = schemaEscapeConnection("\\", rows(
            row("TABLE_NAME", "RT_OBJECTS", "TABLE_TYPE", "TABLE", "REMARKS", null)
        ), capturedArgs);

        List<TableInfo> tables = StandardJdbcMetadata.INSTANCE.listTables(conn, profile, "", "_SYS_RT");

        assertEquals(1, tables.size());
        assertEquals("RT_OBJECTS", tables.get(0).getName());
        // schema 第二个参数应转义为 _\_S\_Y\_S\_R\_T（HANA 转义符为反斜杠）
        assertEquals("\\_SYS\\_RT", capturedArgs.get()[1]);
    }

    @Test
    void listTablesEscapesPercentInQuotedSchema() {
        // 被引号引用、含 % 的 schema（如 "SALES%2024"），% 是通配符，必须转义。
        AtomicReference<Object[]> capturedArgs = new AtomicReference<>();
        Connection conn = schemaEscapeConnection("\\", rows(
            row("TABLE_NAME", "ORDERS_2024", "TABLE_TYPE", "TABLE", "REMARKS", null)
        ), capturedArgs);

        List<TableInfo> tables = StandardJdbcMetadata.INSTANCE.listTables(conn, profile, "", "SALES%2024");

        assertEquals(1, tables.size());
        assertEquals("ORDERS_2024", tables.get(0).getName());
        assertEquals("SALES\\%2024", capturedArgs.get()[1]);
    }

    @Test
    void listTablesLeavesPlainSchemaUntouched() {
        // 普通 schema（无 _ 和 %）不应被转义，且仍作为 schemaPattern 传入。
        AtomicReference<Object[]> capturedArgs = new AtomicReference<>();
        Connection conn = schemaEscapeConnection("\\", rows(
            row("TABLE_NAME", "ORDERS", "TABLE_TYPE", "TABLE", "REMARKS", null)
        ), capturedArgs);

        List<TableInfo> tables = StandardJdbcMetadata.INSTANCE.listTables(conn, profile, "", "SALES");

        assertEquals(1, tables.size());
        assertEquals("ORDERS", tables.get(0).getName());
        assertEquals("SALES", capturedArgs.get()[1]);
    }

    @Test
    void listTablesFallsBackWhenSearchEscapeUnavailable() {
        // 驱动不支持 getSearchStringEscape() 时，schema 原样返回（不做转义），不抛异常。
        AtomicReference<Object[]> capturedArgs = new AtomicReference<>();
        Connection conn = schemaEscapeConnection(null, rows(
            row("TABLE_NAME", "ORDERS", "TABLE_TYPE", "TABLE", "REMARKS", null)
        ), capturedArgs);

        List<TableInfo> tables = StandardJdbcMetadata.INSTANCE.listTables(conn, profile, "", "SALES");

        assertEquals(1, tables.size());
        assertEquals("SALES", capturedArgs.get()[1]);
    }

    private static Connection schemaEscapeConnection(String searchEscape, ResultSet tables, AtomicReference<Object[]> capturedArgs) {
        DatabaseMetaData meta = proxy(DatabaseMetaData.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("getTables".equals(name)) {
                    if (capturedArgs != null) {
                        capturedArgs.set(args);
                    }
                    return tables;
                }
                if ("getTableTypes".equals(name)) {
                    return rows(row("TABLE_TYPE", "TABLE"));
                }
                if ("getSearchStringEscape".equals(name)) {
                    if (searchEscape == null) {
                        throw new UnsupportedOperationException("escape unavailable");
                    }
                    return searchEscape;
                }
                return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                if ("getMetaData".equals(method.getName())) {
                    return meta;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    @Test
    void mapsColumnsWithPrimaryKeysAndLengths() {
        Connection conn = connection(
            rows(),
            rows(),
            rows(row("COLUMN_NAME", "ID")),
            rows(row(
                "COLUMN_NAME", "ID",
                "TYPE_NAME", "INTEGER",
                "NULLABLE", DatabaseMetaData.columnNoNulls,
                "COLUMN_DEF", null,
                "REMARKS", "identifier",
                "COLUMN_SIZE", 10,
                "DECIMAL_DIGITS", 0
            ), row(
                "COLUMN_NAME", "NAME",
                "TYPE_NAME", "VARCHAR",
                "NULLABLE", DatabaseMetaData.columnNullable,
                "COLUMN_DEF", null,
                "REMARKS", null,
                "COLUMN_SIZE", 64,
                "DECIMAL_DIGITS", 0
            )),
            rows(),
            rows()
        );

        List<ColumnInfo> columns = StandardJdbcMetadata.INSTANCE.getColumns(conn, profile, "", "APP", "ORDERS");

        assertEquals("ID", columns.get(0).getName());
        assertTrue(columns.get(0).getIs_primary_key());
        assertFalse(columns.get(0).getIs_nullable());
        assertEquals("NAME", columns.get(1).getName());
        assertEquals(Integer.valueOf(64), columns.get(1).getCharacter_maximum_length());
    }

    @Test
    void marksPrimaryKeysFromConfiguredCatalogWhenColumnsAlreadyLoaded() {
        Connection conn = catalogPrimaryKeyFallbackConnection(
            "TENANTDB",
            rows(),
            rows(row("COLUMN_NAME", "ID")),
            orderColumns()
        );

        List<ColumnInfo> columns = StandardJdbcMetadata.INSTANCE.getColumns(conn, profile, "TENANTDB", "APP", "ORDERS");

        assertEquals("ID", columns.get(0).getName());
        assertTrue(columns.get(0).getIs_primary_key());
        assertFalse(columns.get(0).getIs_nullable());
        assertEquals("NAME", columns.get(1).getName());
        assertFalse(columns.get(1).getIs_primary_key());
        assertEquals(Integer.valueOf(64), columns.get(1).getCharacter_maximum_length());
    }

    @Test
    void doesNotMarkPrimaryKeysFromConfiguredCatalogWhenFallbackUnavailable() {
        JdbcAgentProfile fallbackDisabledProfile = new JdbcAgentProfile(
            "example.Driver",
            "jdbc:example://{host}:{port}/{database}",
            0,
            false,
            Collections.emptySet(),
            Collections.singletonList("TABLE"),
            "\"",
            "SET SCHEMA",
            false,
            false,
            false,
            false
        );
        Connection disabledConn = catalogPrimaryKeyFallbackConnection(
            "TENANTDB",
            rows(),
            rows(row("COLUMN_NAME", "ID")),
            orderColumns()
        );

        List<ColumnInfo> disabledColumns = StandardJdbcMetadata.INSTANCE.getColumns(disabledConn, fallbackDisabledProfile, "TENANTDB", "APP", "ORDERS");

        assertFalse(disabledColumns.get(0).getIs_primary_key());

        Connection emptyCatalogConn = catalogPrimaryKeyFallbackConnection(
            "TENANTDB",
            rows(),
            rows(row("COLUMN_NAME", "ID")),
            orderColumns()
        );

        List<ColumnInfo> emptyCatalogColumns = StandardJdbcMetadata.INSTANCE.getColumns(emptyCatalogConn, profile, " ", "APP", "ORDERS");

        assertFalse(emptyCatalogColumns.get(0).getIs_primary_key());
    }

    @Test
    void groupsIndexColumnsInOrdinalOrder() {
        Connection conn = connection(
            rows(),
            rows(),
            rows(),
            rows(),
            rows(row("INDEX_NAME", "IDX_ORDERS", "COLUMN_NAME", "B", "ORDINAL_POSITION", (short) 2, "NON_UNIQUE", true),
                row("INDEX_NAME", "IDX_ORDERS", "COLUMN_NAME", "A", "ORDINAL_POSITION", (short) 1, "NON_UNIQUE", true)),
            rows()
        );

        List<IndexInfo> indexes = StandardJdbcMetadata.INSTANCE.listIndexes(conn, "APP", "ORDERS");

        assertEquals(1, indexes.size());
        assertEquals(Arrays.asList("A", "B"), indexes.get(0).getColumns());
        assertFalse(indexes.get(0).getIs_unique());
    }

    @Test
    void mapsForeignKeysAndEmptyTriggers() {
        Connection conn = connection(
            rows(),
            rows(),
            rows(),
            rows(),
            rows(),
            rows(row("FK_NAME", null, "FKCOLUMN_NAME", "CUSTOMER_ID", "PKTABLE_NAME", "CUSTOMERS", "PKCOLUMN_NAME", "ID"))
        );

        List<ForeignKeyInfo> foreignKeys = StandardJdbcMetadata.INSTANCE.listForeignKeys(conn, "APP", "ORDERS");

        assertEquals("", foreignKeys.get(0).getName());
        assertEquals("CUSTOMER_ID", foreignKeys.get(0).getColumn());
        assertEquals(Collections.emptyList(), StandardJdbcMetadata.INSTANCE.listTriggers("APP", "ORDERS"));
    }

    @Test
    void completionAssistantSearchesTablesAndColumnsWithServerSideMasks() {
        AtomicReference<Object[]> capturedTableArgs = new AtomicReference<>();
        AtomicReference<Object[]> capturedColumnArgs = new AtomicReference<>();
        Connection conn = connection(
            rows(),
            rows(
                row("TABLE_NAME", "ACCOUNTS", "TABLE_TYPE", "TABLE", "REMARKS", "account table"),
                row("TABLE_NAME", "ACCOUNT_VIEW", "TABLE_TYPE", "VIEW", "REMARKS", null)
            ),
            rows(),
            rows(row("COLUMN_NAME", "DISPLAY_NAME", "TYPE_NAME", "VARCHAR", "NULLABLE", DatabaseMetaData.columnNullable, "COLUMN_DEF", null, "REMARKS", "display")),
            rows(),
            rows(),
            UnsupportedSchemaCall.NONE,
            rows(row("TABLE_TYPE", "TABLE"), row("TABLE_TYPE", "VIEW")),
            null,
            capturedTableArgs,
            capturedColumnArgs
        );

        CompletionAssistantRequest tablesRequest = request("sales", "APP", "ACC", Arrays.asList(CompletionAssistantObjectKind.TABLE, CompletionAssistantObjectKind.VIEW), null);
        CompletionAssistantResponse tables = StandardJdbcMetadata.INSTANCE.completionAssistantSearch(conn, profile, "sales", tablesRequest);

        assertEquals(2, tables.getCandidates().size());
        assertEquals(CompletionAssistantCandidateKind.TABLE, tables.getCandidates().get(0).getKind());
        assertEquals("ACC%", capturedTableArgs.get()[2]);

        CompletionAssistantRequest columnsRequest = request("sales", "APP", "DISPLAY", Collections.singletonList(CompletionAssistantObjectKind.COLUMN), "ACCOUNTS");
        CompletionAssistantResponse columns = StandardJdbcMetadata.INSTANCE.completionAssistantSearch(conn, profile, "sales", columnsRequest);

        assertEquals(1, columns.getCandidates().size());
        assertEquals("DISPLAY_NAME", columns.getCandidates().get(0).getName());
        assertEquals("VARCHAR", columns.getCandidates().get(0).getData_type());
        assertEquals("ACCOUNTS", capturedColumnArgs.get()[2]);
        assertEquals("DISPLAY%", capturedColumnArgs.get()[3]);
    }

    private static Connection connection(
        ResultSet schemas,
        ResultSet tables,
        ResultSet primaryKeys,
        ResultSet columns,
        ResultSet indexes,
        ResultSet foreignKeys
    ) {
        return connection(schemas, tables, primaryKeys, columns, indexes, foreignKeys, false);
    }

    private static Connection connection(
        ResultSet schemas,
        ResultSet tables,
        ResultSet primaryKeys,
        ResultSet columns,
        ResultSet indexes,
        ResultSet foreignKeys,
        boolean unsupportedGetSchema
    ) {
        return connection(
            schemas,
            tables,
            primaryKeys,
            columns,
            indexes,
            foreignKeys,
            unsupportedGetSchema ? UnsupportedSchemaCall.RUNTIME_EXCEPTION : UnsupportedSchemaCall.NONE,
            null,
            null
        );
    }

    private static Connection connection(
        ResultSet schemas,
        ResultSet tables,
        ResultSet primaryKeys,
        ResultSet columns,
        ResultSet indexes,
        ResultSet foreignKeys,
        UnsupportedSchemaCall unsupportedSchemaCall
    ) {
        return connection(schemas, tables, primaryKeys, columns, indexes, foreignKeys, unsupportedSchemaCall, null, null);
    }

    private static Connection connection(
        ResultSet schemas,
        ResultSet tables,
        ResultSet primaryKeys,
        ResultSet columns,
        ResultSet indexes,
        ResultSet foreignKeys,
        ResultSet tableTypes,
        AtomicReference<String[]> capturedTableTypes
    ) {
        return connection(schemas, tables, primaryKeys, columns, indexes, foreignKeys, UnsupportedSchemaCall.NONE, tableTypes, capturedTableTypes);
    }

    private static Connection connection(
        ResultSet schemas,
        ResultSet tables,
        ResultSet primaryKeys,
        ResultSet columns,
        ResultSet indexes,
        ResultSet foreignKeys,
        UnsupportedSchemaCall unsupportedSchemaCall,
        ResultSet tableTypes,
        AtomicReference<String[]> capturedTableTypes
    ) {
        return connection(schemas, tables, primaryKeys, columns, indexes, foreignKeys, unsupportedSchemaCall, tableTypes, capturedTableTypes, null, null);
    }

    private static Connection connection(
        ResultSet schemas,
        ResultSet tables,
        ResultSet primaryKeys,
        ResultSet columns,
        ResultSet indexes,
        ResultSet foreignKeys,
        UnsupportedSchemaCall unsupportedSchemaCall,
        ResultSet tableTypes,
        AtomicReference<String[]> capturedTableTypes,
        AtomicReference<Object[]> capturedTableArgs,
        AtomicReference<Object[]> capturedColumnArgs
    ) {
        return connection(
            schemas,
            tables,
            primaryKeys,
            columns,
            indexes,
            foreignKeys,
            unsupportedSchemaCall,
            tableTypes,
            capturedTableTypes,
            capturedTableArgs,
            capturedColumnArgs,
            null
        );
    }

    private static Connection connection(
        ResultSet schemas,
        ResultSet tables,
        ResultSet primaryKeys,
        ResultSet columns,
        ResultSet indexes,
        ResultSet foreignKeys,
        UnsupportedSchemaCall unsupportedSchemaCall,
        ResultSet tableTypes,
        AtomicReference<String[]> capturedTableTypes,
        AtomicReference<Object[]> capturedTableArgs,
        AtomicReference<Object[]> capturedColumnArgs,
        ResultSet dataTypes
    ) {
        DatabaseMetaData meta = proxy(DatabaseMetaData.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("getSchemas".equals(name)) {
                    if (unsupportedSchemaCall == UnsupportedSchemaCall.METADATA_AND_CONNECTION_ABSTRACT_METHOD_ERROR) {
                        throw new AbstractMethodError("Unimplemented method: getSchemas()");
                    }
                    return schemas;
                }
                if ("getTables".equals(name)) {
                    if (capturedTableArgs != null) {
                        capturedTableArgs.set(args);
                    }
                    if (capturedTableTypes != null && args != null && args.length > 3) {
                        capturedTableTypes.set((String[]) args[3]);
                    }
                    return tables;
                }
                if ("getTableTypes".equals(name) && tableTypes != null) {
                    return tableTypes;
                }
                if ("getTypeInfo".equals(name) && dataTypes != null) {
                    return dataTypes;
                }
                if ("getPrimaryKeys".equals(name)) {
                    return primaryKeys;
                }
                if ("getColumns".equals(name)) {
                    if (capturedColumnArgs != null) {
                        capturedColumnArgs.set(args);
                    }
                    return columns;
                }
                if ("getIndexInfo".equals(name)) {
                    return indexes;
                }
                if ("getImportedKeys".equals(name)) {
                    return foreignKeys;
                }
                if ("getCatalogs".equals(name)) {
                    return rows();
                }
                return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                if ("getMetaData".equals(method.getName())) {
                    return meta;
                }
                if ("getSchema".equals(method.getName())) {
                    if (unsupportedSchemaCall == UnsupportedSchemaCall.RUNTIME_EXCEPTION) {
                        throw new RuntimeException("Unimplemented method: getSchema()");
                    }
                    if (unsupportedSchemaCall == UnsupportedSchemaCall.ABSTRACT_METHOD_ERROR
                        || unsupportedSchemaCall == UnsupportedSchemaCall.METADATA_AND_CONNECTION_ABSTRACT_METHOD_ERROR) {
                        throw new AbstractMethodError("Unimplemented method: getSchema()");
                    }
                    return null;
                }
                if ("getCatalog".equals(method.getName())) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static Connection catalogPrimaryKeyFallbackConnection(
        String fallbackCatalog,
        ResultSet defaultPrimaryKeys,
        ResultSet fallbackPrimaryKeys,
        ResultSet columns
    ) {
        DatabaseMetaData meta = proxy(DatabaseMetaData.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("getPrimaryKeys".equals(name)) {
                    return fallbackCatalog.equals(args[0]) ? fallbackPrimaryKeys : defaultPrimaryKeys;
                }
                if ("getColumns".equals(name)) {
                    return columns;
                }
                if ("getCatalogs".equals(name)) {
                    return rows();
                }
                return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                if ("getMetaData".equals(method.getName())) {
                    return meta;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static Connection routineConnection(ResultSet procedures, ResultSet functions) {
        DatabaseMetaData meta = proxy(DatabaseMetaData.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("getTables".equals(name) || "getTableTypes".equals(name)) {
                    return rows();
                }
                if ("getProcedures".equals(name)) {
                    return procedures;
                }
                if ("getFunctions".equals(name)) {
                    return functions;
                }
                return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                if ("getMetaData".equals(method.getName())) {
                    return meta;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet orderColumns() {
        return rows(row(
            "COLUMN_NAME", "ID",
            "TYPE_NAME", "INTEGER",
            "NULLABLE", DatabaseMetaData.columnNoNulls,
            "COLUMN_DEF", null,
            "REMARKS", "identifier",
            "COLUMN_SIZE", 10,
            "DECIMAL_DIGITS", 0
        ), row(
            "COLUMN_NAME", "NAME",
            "TYPE_NAME", "VARCHAR",
            "NULLABLE", DatabaseMetaData.columnNullable,
            "COLUMN_DEF", null,
            "REMARKS", null,
            "COLUMN_SIZE", 64,
            "DECIMAL_DIGITS", 0
        ));
    }

    private static ResultSet rows(Map<String, Object>... rows) {
        return proxy(ResultSet.class, new MethodHandler() {
            private int index = -1;

            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("next".equals(name)) {
                    index += 1;
                    return index < rows.length;
                }
                if ("close".equals(name)) {
                    return null;
                }
                Object value = rows[index].get(args[0]);
                if ("getString".equals(name)) {
                    return value == null ? null : String.valueOf(value);
                }
                if ("getObject".equals(name)) {
                    return value;
                }
                if ("getInt".equals(name)) {
                    return value instanceof Number ? ((Number) value).intValue() : 0;
                }
                if ("getShort".equals(name)) {
                    return value instanceof Number ? ((Number) value).shortValue() : 0;
                }
                if ("getBoolean".equals(name)) {
                    return value instanceof Boolean && (Boolean) value;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static Map<String, Object> row(Object... values) {
        Map<String, Object> row = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) {
            row.put(String.valueOf(values[i]), values[i + 1]);
        }
        return row;
    }

    private static CompletionAssistantRequest request(
        String database,
        String schema,
        String mask,
        List<CompletionAssistantObjectKind> kinds,
        String parentName
    ) {
        CompletionAssistantRequest request = new CompletionAssistantRequest();
        setField(request, "database", database);
        setField(request, "schema", schema);
        setField(request, "mask", mask);
        setField(request, "object_kinds", kinds);
        setField(request, "parent_schema", schema);
        setField(request, "parent_name", parentName);
        setField(request, "max_results", 10);
        setField(request, "match_mode", CompletionAssistantMatchMode.PREFIX);
        return request;
    }

    private static void setField(Object target, String name, Object value) {
        try {
            java.lang.reflect.Field field = target.getClass().getDeclaredField(name);
            field.setAccessible(true);
            field.set(target, value);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static <T> T proxy(Class<T> type, final MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                return handler.handle(method, args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
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

    private interface MethodHandler {
        Object handle(Method method, Object[] args);
    }

    private enum UnsupportedSchemaCall {
        NONE,
        RUNTIME_EXCEPTION,
        ABSTRACT_METHOD_ERROR,
        METADATA_AND_CONNECTION_ABSTRACT_METHOD_ERROR
    }
}

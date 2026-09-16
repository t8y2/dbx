package com.dbx.agent.spanner;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Array;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SpannerAgentTest extends JdbcFakeExecutionBehaviorTest {
    private static final String GOOGLE_SQL_PRODUCT = "Google Cloud Spanner";
    private static final String POSTGRES_PRODUCT = "Google Cloud Spanner PostgreSQL";

    @Override
    protected DatabaseAgent createAgent() {
        return new SpannerAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SHOW VARIABLE AUTOCOMMIT";
    }

    @Test
    void usesBacktickIdentifierQuoteForGoogleSqlDialect() {
        SpannerAgent agent = new SpannerAgent();

        agent.detectDialect(fakeConnection(GOOGLE_SQL_PRODUCT, null, new LinkedHashMap<>()));

        assertEquals("`", agent.getIdentifierQuote());
    }

    @Test
    void usesDoubleQuoteIdentifierQuoteForPostgresDialect() {
        SpannerAgent agent = new SpannerAgent();

        agent.detectDialect(fakeConnection(POSTGRES_PRODUCT, "public", new LinkedHashMap<>()));

        assertEquals("\"", agent.getIdentifierQuote());
    }

    @Test
    void keepsBacktickQuoteBeforeTheDialectIsProbed() {
        assertEquals("`", new SpannerAgent().getIdentifierQuote());
    }

    @Test
    void reportsTheEmptyGoogleSqlSchemaInsteadOfDroppingIt() {
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, new LinkedHashMap<>());

        // The fake connection cannot create statements, so this exercises the fallback taken when
        // INFORMATION_SCHEMA.SCHEMATA is unreadable: the default schema is still reported, and it is
        // the empty string that GoogleSQL uses for its user schema. Named-schema discovery runs
        // against the emulator instead — a proxy cannot answer a real catalog query.
        assertEquals(Collections.singletonList(""), agent.listSchemas());
    }

    @Test
    void reportsThePostgresDialectSchema() {
        SpannerAgent agent = connectedAgent(POSTGRES_PRODUCT, "public", new LinkedHashMap<>());

        // Same fallback path as above; the PostgreSQL dialect's default schema is `public`.
        assertEquals(Collections.singletonList("public"), agent.listSchemas());
    }

    @Test
    void passesTheEmptyGoogleSqlSchemaVerbatimToTheDriver() {
        List<String> calls = new ArrayList<>();
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getTables", Arrays.asList(
            row("TABLE_NAME", "singers", "TABLE_TYPE", "TABLE"),
            row("TABLE_NAME", "v_singer_albums", "TABLE_TYPE", "VIEW")
        ));
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows, calls);

        List<TableInfo> tables = agent.listTables("");

        assertEquals(Arrays.asList("singers", "v_singer_albums"), names(tables));
        assertEquals("TABLE", tables.get(0).getTable_type());
        assertEquals("VIEW", tables.get(1).getTable_type());
        // Empty string, never null: null would also return the INFORMATION_SCHEMA/SPANNER_SYS views.
        assertEquals(Collections.singletonList("getTables(catalog=null, schema=[], pattern=%, types=[TABLE, VIEW])"), calls);
    }

    @Test
    void fallsBackToTheDialectSchemaWhenTheCallerSendsNone() {
        List<String> calls = new ArrayList<>();
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getTables", Collections.emptyList());
        SpannerAgent agent = connectedAgent(POSTGRES_PRODUCT, "public", rows, calls);

        agent.listTables(null);

        assertEquals(
            Collections.singletonList("getTables(catalog=null, schema=[public], pattern=%, types=[TABLE, VIEW])"),
            calls
        );
    }

    @Test
    void treatsTheResourcePathAsAnUnspecifiedSchema() {
        List<String> calls = new ArrayList<>();
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getTables", Collections.singletonList(row("TABLE_NAME", "singers", "TABLE_TYPE", "TABLE")));
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows, calls);

        // Hosts without a schema level send the database identifier as the metadata schema, and for
        // Spanner that identifier is the resource path. Forwarding it verbatim matches nothing.
        assertEquals(
            Collections.singletonList("singers"),
            names(agent.listTables("projects/test-project/instances/test-instance/databases/gsqldb"))
        );
        assertEquals(Collections.singletonList("getTables(catalog=null, schema=[], pattern=%, types=[TABLE, VIEW])"), calls);
    }

    @Test
    void resolvesTheSchemaBeforeRenderingTableDdl() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getColumns", Collections.singletonList(row(
            "COLUMN_NAME", "singer_id",
            "TYPE_NAME", "INT64",
            "NULLABLE", DatabaseMetaData.columnNoNulls
        )));
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows);

        String ddl = agent.getTableDdl("projects/test-project/instances/test-instance/databases/gsqldb", "singers");

        // The resource path must not become a DDL qualifier, and the columns must still resolve.
        assertFalse(ddl.contains("projects/"));
        assertTrue(ddl.contains("singers"));
        assertTrue(ddl.contains("singer_id"));
    }

    @Test
    void quotesGeneratedDdlWithTheDialectQuote() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getColumns", Collections.singletonList(row(
            "COLUMN_NAME", "singer_id",
            "TYPE_NAME", "INT64",
            "NULLABLE", DatabaseMetaData.columnNoNulls
        )));

        // The shared builder hardcodes ANSI double quotes, which GoogleSQL reads as a string
        // literal rather than an identifier.
        String googleSql = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows).getTableDdl("", "singers");
        assertTrue(googleSql.contains("`singers`"), googleSql);
        assertFalse(googleSql.contains("\"singers\""), googleSql);

        String postgres = connectedAgent(POSTGRES_PRODUCT, "public", rows).getTableDdl("public", "singers");
        assertTrue(postgres.contains("\"singers\""), postgres);
        assertFalse(postgres.contains("`singers`"), postgres);
    }

    @Test
    void skipsStoringIndexColumnsThatHaveNoOrdinalPosition() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getIndexInfo", Arrays.asList(
            indexRow("PRIMARY_KEY", "singer_id", 1, false),
            indexRow("PRIMARY_KEY", "album_id", 2, false),
            // STORING (GoogleSQL) / INCLUDE (PostgreSQL) column: ORDINAL_POSITION is NULL and the
            // driver returns it before the real key column.
            indexRow("idx_albums_title", "release_ts", null, true),
            indexRow("idx_albums_title", "title", 1, true)
        ));
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows);

        List<IndexInfo> indexes = agent.listIndexes("", "albums");

        assertEquals(2, indexes.size());
        IndexInfo primaryKey = indexes.get(0);
        assertEquals("PRIMARY_KEY", primaryKey.getName());
        assertEquals(Arrays.asList("singer_id", "album_id"), primaryKey.getColumns());
        assertTrue(primaryKey.getIs_unique());
        // Spanner names the primary key index PRIMARY_KEY, so a "PRIMARY" comparison never matches.
        assertTrue(primaryKey.getIs_primary());
        assertNull(primaryKey.getIncluded_columns());

        IndexInfo secondary = indexes.get(1);
        assertEquals("idx_albums_title", secondary.getName());
        assertEquals(Collections.singletonList("title"), secondary.getColumns());
        assertEquals(Collections.singletonList("release_ts"), secondary.getIncluded_columns());
        assertFalse(secondary.getIs_unique());
        assertFalse(secondary.getIs_primary());
    }

    @Test
    void skipsUnnamedInterleaveRelationshipsReportedAsForeignKeys() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getImportedKeys", Arrays.asList(
            row(
                "FK_NAME", null,
                "FKCOLUMN_NAME", "singer_id",
                "PKTABLE_NAME", "singers",
                "PKCOLUMN_NAME", "singer_id"
            ),
            row(
                "FK_NAME", "fk_concerts_singer",
                "FKCOLUMN_NAME", "singer_id",
                "PKTABLE_NAME", "singers",
                "PKCOLUMN_NAME", "singer_id"
            )
        ));
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows);

        List<ForeignKeyInfo> foreignKeys = agent.listForeignKeys("", "albums");

        assertEquals(1, foreignKeys.size());
        assertEquals("fk_concerts_singer", foreignKeys.get(0).getName());
    }

    @Test
    void keepsNativeSpannerTypeNamesOnColumns() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getPrimaryKeys", Collections.singletonList(row("COLUMN_NAME", "singer_id")));
        rows.put("getColumns", Arrays.asList(
            row(
                "COLUMN_NAME", "singer_id",
                "TYPE_NAME", "INT64",
                "NULLABLE", DatabaseMetaData.columnNoNulls
            ),
            row(
                "COLUMN_NAME", "tags",
                "TYPE_NAME", "ARRAY<STRING(MAX)>",
                "NULLABLE", DatabaseMetaData.columnNullable
            )
        ));
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows);

        List<ColumnInfo> columns = agent.getColumns("", "singers");

        assertEquals(Arrays.asList("singer_id", "tags"), Arrays.asList(
            columns.get(0).getName(),
            columns.get(1).getName()
        ));
        assertEquals("INT64", columns.get(0).getData_type());
        assertTrue(columns.get(0).getIs_primary_key());
        assertFalse(columns.get(0).getIs_nullable());
        assertEquals("ARRAY<STRING(MAX)>", columns.get(1).getData_type());
        assertFalse(columns.get(1).getIs_primary_key());
        assertTrue(columns.get(1).getIs_nullable());
    }

    @Test
    void readsArrayValuesInOrderWithoutUsingGetStringAndFreesTheArray() {
        List<String> calls = new ArrayList<>();
        Array array = fakeArray(new Object[]{7L, "two", null}, calls, false);
        ResultSet resultSet = arrayResultSet(array, calls);

        Object value = resultValue(new SpannerAgent(), resultSet, Types.ARRAY);

        assertEquals(Arrays.asList(7L, "two", null), value);
        assertEquals(Arrays.asList("getArray(1)", "array.getArray()", "array.free()"), calls);
    }

    @Test
    void returnsNullForNullArraysWithoutUsingGetString() {
        List<String> calls = new ArrayList<>();
        ResultSet resultSet = arrayResultSet(null, calls);

        assertNull(resultValue(new SpannerAgent(), resultSet, Types.ARRAY));
        assertEquals(Collections.singletonList("getArray(1)"), calls);
    }

    @Test
    void keepsTheReadArrayValueWhenFreeFails() {
        List<String> calls = new ArrayList<>();
        Array array = fakeArray(new String[]{"first", "second"}, calls, true);

        Object value = resultValue(new SpannerAgent(), arrayResultSet(array, calls), Types.ARRAY);

        assertEquals(Arrays.asList("first", "second"), value);
        assertEquals(Arrays.asList("getArray(1)", "array.getArray()", "array.free()"), calls);
    }

    @Test
    void delegatesScalarValuesToTheSharedReader() {
        List<String> calls = new ArrayList<>();
        ResultSet resultSet = proxy(ResultSet.class, (method, args) -> {
            if ("getInt".equals(method.getName())) {
                calls.add("getInt(" + args[0] + ")");
                return 42;
            }
            if ("wasNull".equals(method.getName())) {
                calls.add("wasNull()");
                return false;
            }
            if ("getArray".equals(method.getName()) || "getString".equals(method.getName())) {
                throw new AssertionError("Unexpected " + method.getName());
            }
            return defaultValue(method.getReturnType());
        });

        assertEquals(42, resultValue(new SpannerAgent(), resultSet, Types.INTEGER));
        assertEquals(Arrays.asList("getInt(1)", "wasNull()"), calls);
    }

    @Test
    void omitsIntrinsicNumericParametersWhileKeepingNativeArrayAndStringTypes() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getColumns", Arrays.asList(
            row(
                "COLUMN_NAME", "amount",
                "TYPE_NAME", "NUMERIC",
                "NULLABLE", DatabaseMetaData.columnNullable,
                "COLUMN_SIZE", 15,
                "DECIMAL_DIGITS", 0
            ),
            row(
                "COLUMN_NAME", "ratio",
                "TYPE_NAME", "DECIMAL",
                "NULLABLE", DatabaseMetaData.columnNullable,
                "COLUMN_SIZE", 15,
                "DECIMAL_DIGITS", 0
            ),
            row(
                "COLUMN_NAME", "tags",
                "TYPE_NAME", "ARRAY<STRING(MAX)>",
                "NULLABLE", DatabaseMetaData.columnNullable
            ),
            row(
                "COLUMN_NAME", "nickname",
                "TYPE_NAME", "STRING(100)",
                "NULLABLE", DatabaseMetaData.columnNullable,
                "COLUMN_SIZE", 100
            )
        ));
        SpannerAgent agent = connectedAgent(GOOGLE_SQL_PRODUCT, null, rows);

        List<ColumnInfo> columns = agent.getColumns("", "singers");
        String ddl = agent.getTableDdl("", "singers");

        assertNull(columns.get(0).getNumeric_precision());
        assertNull(columns.get(0).getNumeric_scale());
        assertNull(columns.get(1).getNumeric_precision());
        assertNull(columns.get(1).getNumeric_scale());
        assertTrue(ddl.contains("`amount` NUMERIC"), ddl);
        assertTrue(ddl.contains("`ratio` DECIMAL"), ddl);
        assertFalse(ddl.contains("NUMERIC("), ddl);
        assertFalse(ddl.contains("DECIMAL("), ddl);
        assertTrue(ddl.contains("`tags` ARRAY<STRING(MAX)>"), ddl);
        assertTrue(ddl.contains("`nickname` STRING(100)"), ddl);
    }

    @Test
    void reportsTheConfiguredDatabaseOnlyOnce() {
        SpannerAgent agent = connectedAgent(POSTGRES_PRODUCT, "public", new LinkedHashMap<>());
        String resourcePath = "projects/test-project/instances/test-instance/databases/pgdb";
        setConfiguredDatabase(agent, resourcePath);

        // The shared adapter reports [pgdb, projects/.../databases/pgdb] for the PostgreSQL dialect.
        // The fake connection cannot unwrap to CloudSpannerJdbcConnection, so this also pins the
        // fallback taken whenever the Admin API is unavailable — a caller without
        // spanner.databases.list still sees the database it connected to.
        //
        // The invariant both paths share: a reported name is the *full resource path*, because it
        // round-trips as ConnectParams.database and only the path builds a resolvable JDBC URL. A
        // bare database id would make every click on a sibling database hang until the connect
        // timeout. The Admin API branch cannot be reached through this proxy, so that half is
        // verified against the emulator by reconnecting with each name it reports.
        assertEquals(Collections.singletonList(resourcePath), databaseNames(agent.listDatabases()));
    }

    @Test
    void translatesDataTypeNamesForThePostgresDialect() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        rows.put("getTypeInfo", Arrays.asList(
            row("TYPE_NAME", "INT64"),
            row("TYPE_NAME", "STRING"),
            row("TYPE_NAME", "FLOAT64"),
            row("TYPE_NAME", "JSON")
        ));
        Map<String, List<Map<String, Object>>> postgresRows = new LinkedHashMap<>();
        postgresRows.put("getTypeInfo", Arrays.asList(
            row("TYPE_NAME", "INT64"),
            row("TYPE_NAME", "STRING"),
            row("TYPE_NAME", "FLOAT64"),
            // The driver answers JSONB here rather than JSON, but still in upper case.
            row("TYPE_NAME", "JSONB")
        ));

        // The driver answers getTypeInfo() with GoogleSQL spellings for both dialects, so a
        // PostgreSQL-dialect database would otherwise be offered INT64/STRING in field mapping.
        assertEquals(
            Arrays.asList("INT64", "STRING", "FLOAT64", "JSON"),
            connectedAgent(GOOGLE_SQL_PRODUCT, null, rows).listDataTypes()
        );
        assertEquals(
            Arrays.asList("bigint", "character varying", "double precision", "jsonb"),
            connectedAgent(POSTGRES_PRODUCT, "public", postgresRows).listDataTypes()
        );
    }

    @Test
    void omitsTheEndpointWhenNoHostIsConfigured() {
        ConnectParams params = new ConnectParams();
        params.setDatabase("projects/p/instances/i/databases/d");

        assertEquals("jdbc:cloudspanner:/projects/p/instances/i/databases/d", SpannerAgent.spannerUrl(params));
    }

    @Test
    void buildsAnEndpointUrlForTheEmulator() {
        ConnectParams params = new ConnectParams();
        params.setHost("localhost");
        params.setPort(9010);
        params.setDatabase("projects/p/instances/i/databases/d");
        params.setUrl_params("usePlainText=true;autoConfigEmulator=true");

        assertEquals(
            "jdbc:cloudspanner://localhost:9010/projects/p/instances/i/databases/d"
                + "?usePlainText=true;autoConfigEmulator=true",
            SpannerAgent.spannerUrl(params)
        );
    }

    @Test
    void defaultsALoopbackEndpointToPlaintextBecauseTheEmulatorRejectsTls() {
        ConnectParams params = new ConnectParams();
        params.setHost("127.0.0.1");
        params.setPort(9010);
        params.setDatabase("projects/p/instances/i/databases/d");

        // Without this the driver treats the emulator as a production endpoint, retries a TLS
        // handshake against a plaintext port for the whole connect timeout, and fails with
        // `UNAVAILABLE: io exception`.
        assertEquals(
            "jdbc:cloudspanner://127.0.0.1:9010/projects/p/instances/i/databases/d?usePlainText=true",
            SpannerAgent.spannerUrl(params)
        );
    }

    @Test
    void appendsPlaintextAfterTheConfiguredParamsForALoopbackEndpoint() {
        ConnectParams params = new ConnectParams();
        params.setHost("localhost");
        params.setPort(9010);
        params.setDatabase("projects/p/instances/i/databases/d");
        params.setUrl_params("autocommit=true");

        assertEquals(
            "jdbc:cloudspanner://localhost:9010/projects/p/instances/i/databases/d"
                + "?autocommit=true;usePlainText=true",
            SpannerAgent.spannerUrl(params)
        );
    }

    @Test
    void keepsAnExplicitPlaintextChoiceIncludingOptingOut() {
        ConnectParams optOut = new ConnectParams();
        optOut.setHost("localhost");
        optOut.setPort(9010);
        optOut.setDatabase("projects/p/instances/i/databases/d");
        optOut.setUrl_params("usePlainText=false");

        assertEquals(
            "jdbc:cloudspanner://localhost:9010/projects/p/instances/i/databases/d?usePlainText=false",
            SpannerAgent.spannerUrl(optOut)
        );

        // autoConfigEmulator already implies plaintext, and it additionally creates a missing
        // instance and database, so it must not be silently paired with usePlainText.
        ConnectParams autoConfig = new ConnectParams();
        autoConfig.setHost("localhost");
        autoConfig.setPort(9010);
        autoConfig.setDatabase("projects/p/instances/i/databases/d");
        autoConfig.setUrl_params("autoConfigEmulator=true");

        assertEquals(
            "jdbc:cloudspanner://localhost:9010/projects/p/instances/i/databases/d?autoConfigEmulator=true",
            SpannerAgent.spannerUrl(autoConfig)
        );
    }

    @Test
    void leavesRemoteEndpointsOnTls() {
        // A non-loopback host may well be a private or proxied Spanner endpoint, so plaintext stays
        // opt-in there. The host-less form used for the real service is covered separately.
        ConnectParams params = new ConnectParams();
        params.setHost("spanner.internal.example.com");
        params.setPort(443);
        params.setDatabase("projects/p/instances/i/databases/d");

        assertEquals(
            "jdbc:cloudspanner://spanner.internal.example.com:443/projects/p/instances/i/databases/d",
            SpannerAgent.spannerUrl(params)
        );
    }

    @Test
    void usesTheDefaultPortWhenNoneIsConfigured() {
        ConnectParams params = new ConnectParams();
        params.setHost("spanner.googleapis.com");
        params.setDatabase("projects/p/instances/i/databases/d");

        assertEquals(
            "jdbc:cloudspanner://spanner.googleapis.com:443/projects/p/instances/i/databases/d",
            SpannerAgent.spannerUrl(params)
        );
    }

    @Test
    void skipsSchemaSwitchingBecauseSpannerHasNoSchemaStatement() {
        assertEquals("", new SpannerAgent().setSchemaSQL("public"));
    }

    private static List<String> names(List<TableInfo> tables) {
        List<String> result = new ArrayList<>();
        for (TableInfo table : tables) {
            result.add(table.getName());
        }
        return result;
    }

    private static List<String> databaseNames(List<DatabaseInfo> databases) {
        List<String> result = new ArrayList<>();
        for (DatabaseInfo database : databases) {
            result.add(database.getName());
        }
        return result;
    }

    private static void setConfiguredDatabase(SpannerAgent agent, String database) {
        for (Class<?> type = agent.getClass(); type != null; type = type.getSuperclass()) {
            try {
                Field field = type.getDeclaredField("configuredDatabase");
                field.setAccessible(true);
                field.set(agent, database);
            } catch (NoSuchFieldException ignored) {
                continue;
            } catch (IllegalAccessException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    private static SpannerAgent connectedAgent(
        String product,
        String schema,
        Map<String, List<Map<String, Object>>> rowsByCall
    ) {
        return connectedAgent(product, schema, rowsByCall, new ArrayList<>());
    }

    private static SpannerAgent connectedAgent(
        String product,
        String schema,
        Map<String, List<Map<String, Object>>> rowsByCall,
        List<String> calls
    ) {
        SpannerAgent agent = new SpannerAgent();
        Connection conn = fakeConnection(product, schema, rowsByCall, calls);
        agent.detectDialect(conn);
        TestSupport.setPrivateConnection(agent, conn);
        return agent;
    }

    private static Connection fakeConnection(
        String product,
        String schema,
        Map<String, List<Map<String, Object>>> rowsByCall
    ) {
        return fakeConnection(product, schema, rowsByCall, new ArrayList<>());
    }

    private static Connection fakeConnection(
        String product,
        String schema,
        Map<String, List<Map<String, Object>>> rowsByCall,
        List<String> calls
    ) {
        DatabaseMetaData metaData = fakeMetaData(product, rowsByCall, calls);
        return proxy(Connection.class, (method, args) -> {
            String name = method.getName();
            if ("getMetaData".equals(name)) {
                return metaData;
            }
            if ("getSchema".equals(name)) {
                return schema;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static DatabaseMetaData fakeMetaData(
        String product,
        Map<String, List<Map<String, Object>>> rowsByCall,
        List<String> calls
    ) {
        return proxy(DatabaseMetaData.class, (method, args) -> {
            String name = method.getName();
            if ("getDatabaseProductName".equals(name)) {
                return product;
            }
            if ("getTables".equals(name)) {
                calls.add("getTables(catalog=" + args[0] + ", schema=[" + args[1] + "], pattern=" + args[2]
                    + ", types=" + Arrays.toString((String[]) args[3]) + ")");
                return fakeResultSet(rowsByCall.get("getTables"));
            }
            if ("getColumns".equals(name) || "getPrimaryKeys".equals(name)
                || "getIndexInfo".equals(name) || "getImportedKeys".equals(name)) {
                calls.add(name + "(catalog=" + args[0] + ", schema=[" + args[1] + "], table=" + args[2] + ")");
                return fakeResultSet(rowsByCall.get(name));
            }
            if ("getTypeInfo".equals(name)) {
                // Takes no arguments, so it is not recorded alongside the schema-scoped calls.
                return fakeResultSet(rowsByCall.get("getTypeInfo"));
            }
            if ("getSearchStringEscape".equals(name)) {
                return "\\";
            }
            if ("getIdentifierQuoteString".equals(name)) {
                // The driver hardcodes a backtick for both dialects; the agent must not trust it.
                return "`";
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet fakeResultSet(List<Map<String, Object>> rows) {
        List<Map<String, Object>> values = rows == null ? Collections.emptyList() : rows;
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] < values.size();
            }
            if ("getString".equals(name)) {
                Object value = values.get(index[0]).get((String) args[0]);
                return value == null ? null : String.valueOf(value);
            }
            if ("getObject".equals(name)) {
                return values.get(index[0]).get((String) args[0]);
            }
            if ("getInt".equals(name)) {
                Object value = values.get(index[0]).get((String) args[0]);
                return value instanceof Number ? ((Number) value).intValue() : 0;
            }
            if ("getBoolean".equals(name)) {
                Object value = values.get(index[0]).get((String) args[0]);
                return Boolean.TRUE.equals(value);
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet arrayResultSet(Array array, List<String> calls) {
        return proxy(ResultSet.class, (method, args) -> {
            if ("getArray".equals(method.getName())) {
                calls.add("getArray(" + args[0] + ")");
                return array;
            }
            if ("getString".equals(method.getName())) {
                throw new AssertionError("ARRAY values must not be read with getString");
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Array fakeArray(Object value, List<String> calls, boolean failFree) {
        return proxy(Array.class, (method, args) -> {
            if ("getArray".equals(method.getName())) {
                calls.add("array.getArray()");
                return value;
            }
            if ("free".equals(method.getName())) {
                calls.add("array.free()");
                if (failFree) {
                    throw new SQLException("cleanup failed");
                }
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Object resultValue(SpannerAgent agent, ResultSet resultSet, int sqlType) {
        try {
            Method method = SpannerAgent.class.getDeclaredMethod("resultValue", ResultSet.class, int.class, int.class);
            method.setAccessible(true);
            return method.invoke(agent, resultSet, 1, sqlType);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException) {
                throw (RuntimeException) cause;
            }
            if (cause instanceof Error) {
                throw (Error) cause;
            }
            throw new IllegalStateException(cause);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Map<String, Object> row(Object... keyValues) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            result.put((String) keyValues[i], keyValues[i + 1]);
        }
        return result;
    }

    private static Map<String, Object> indexRow(String indexName, String column, Integer ordinal, boolean nonUnique) {
        return row(
            "INDEX_NAME", indexName,
            "COLUMN_NAME", column,
            "ORDINAL_POSITION", ordinal,
            "NON_UNIQUE", nonUnique
        );
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object instance, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler);
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) {
            return false;
        }
        if (Integer.TYPE.equals(type)) {
            return 0;
        }
        if (Short.TYPE.equals(type)) {
            return (short) 0;
        }
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}

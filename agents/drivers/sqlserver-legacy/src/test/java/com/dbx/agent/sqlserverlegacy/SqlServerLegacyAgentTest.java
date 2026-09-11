package com.dbx.agent.sqlserverlegacy;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.security.Security;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

class SqlServerLegacyAgentTest {
    @Test
    void onlySqlServer8UnsupportedErrorsTriggerTheOldDriverFallback() {
        // Real mssql-jdbc prelogin rejection for SQL Server 2000
        // (R_unsupportedServerVersion, English-only resources).
        Assertions.assertTrue(SqlServerLegacyAgent.isSqlServer2000Unsupported(
            new SQLException("SQL Server version 8 is not supported by this driver.")
        ));
        // Older driver wordings name the supported floor instead
        // (mssql-jdbc R_notSQLServer family).
        Assertions.assertTrue(SqlServerLegacyAgent.isSqlServer2000Unsupported(
            new SQLException("This version of the driver can be used only with SQL Server 2005 or later.")
        ));
        Assertions.assertTrue(SqlServerLegacyAgent.isSqlServer2000Unsupported(
            new SQLException("该驱动程序不支持 SQL Server 8 版")
        ));
        Assertions.assertTrue(SqlServerLegacyAgent.isSqlServer2000Unsupported(
            new SQLException("The driver does not support SQL Server 8")
        ));
        Assertions.assertFalse(SqlServerLegacyAgent.isSqlServer2000Unsupported(
            new SQLException("TLS handshake failed")
        ));
        Assertions.assertFalse(SqlServerLegacyAgent.isSqlServer2000Unsupported(
            new SQLException("Login failed for user 'sa'")
        ));
    }

    @Test
    void jtdsUrlUsesLegacySqlServerSyntax() {
        ConnectParams params = new ConnectParams(
            "db.example.com",
            1433,
            "appdb",
            "sa",
            "secret",
            "applicationName=dbx;encrypt=true;sslProtocol=TLSv1",
            "",
            false
        );

        Assertions.assertEquals(
            "jdbc:jtds:sqlserver://db.example.com:1433/appdb;appName=dbx",
            SqlServerLegacyAgent.jtdsUrl(params)
        );
    }

    @Test
    void jtdsUrlPreservesExplicitPortForNamedInstance() {
        ConnectParams params = new ConnectParams(
            "db.example.com\\MSSQLSERVER",
            11433,
            "appdb",
            "sa",
            "secret",
            "",
            "",
            false
        );
        params.setPort_explicit(true);

        Assertions.assertEquals(
            "jdbc:jtds:sqlserver://db.example.com:11433/appdb",
            SqlServerLegacyAgent.jtdsUrl(params)
        );
    }

    @Test
    void metadataSchemaKeepsExplicitSchemaAndResolvesDefault() {
        Assertions.assertEquals("sales", SqlServerLegacyAgent.normalizeMetadataSchema("sales", "dbo"));
        Assertions.assertEquals("tenant_owner", SqlServerLegacyAgent.normalizeMetadataSchema("", "tenant_owner"));
        Assertions.assertEquals("dbo", SqlServerLegacyAgent.normalizeMetadataSchema(null, "  "));
        Assertions.assertEquals(
            "SELECT COALESCE(OBJECT_SCHEMA_NAME(OBJECT_ID(QUOTENAME(?))), NULLIF(SCHEMA_NAME(), N''), N'dbo') AS schema_name",
            SqlServerLegacyAgent.unqualifiedObjectSchemaSql()
        );
        Assertions.assertEquals(
            "SELECT TOP 1 u.name AS schema_name FROM sysobjects o JOIN sysusers u ON o.uid = u.uid "
                + "WHERE o.name = ? AND o.xtype IN ('U', 'V', 'P', 'FN', 'IF', 'TF') "
                + "ORDER BY CASE WHEN u.name = 'dbo' THEN 0 ELSE 1 END, u.name",
            SqlServerLegacyAgent.sqlServer2000ObjectSchemaSql()
        );
    }

    @Test
    void sqlServer2000ObjectSourceReadsOrderedProcedureChunks() {
        Assertions.assertEquals(
            "SELECT c.text AS source_text FROM syscomments c JOIN sysobjects o ON c.id = o.id "
                + "JOIN sysusers u ON o.uid = u.uid WHERE u.name = ? AND o.name = ? AND o.xtype = ? "
                + "ORDER BY c.colid",
            SqlServerLegacyAgent.sqlServer2000ObjectSourceSql()
        );
    }

    @Test
    void sqlServer2000ColumnCommentsEnrichJdbcColumnRemarks() {
        SqlServerLegacyAgent agent = new SqlServerLegacyAgent();
        TestSupport.setPrivateConnection(agent, sqlServer2000CommentConnection(
            Arrays.asList(
                Arrays.asList("ID", "Primary identifier", "MS_Description"),
                Arrays.asList("NAME", "Custom label", "CUSTOM_PROP"),
                Arrays.asList("NAME", "Display name", "MS_Description")
            ),
            null,
            null
        ));
        setSqlServer2000Mode(agent, true);

        List<ColumnInfo> columns = agent.getColumns("dbo", "USERS");

        Assertions.assertEquals(List.of("ID", "NAME", "CREATED_AT"), columns.stream().map(ColumnInfo::getName).toList());
        Assertions.assertEquals("Primary identifier", columns.get(0).getComment());
        // MS_Description outranks other extended properties on the same column.
        Assertions.assertEquals("Display name", columns.get(1).getComment());
        // Columns without an extended property keep their JDBC remark untouched.
        Assertions.assertEquals("JDBC remark", columns.get(2).getComment());
        Assertions.assertTrue(columns.get(0).getIs_nullable());
        Assertions.assertFalse(columns.get(2).getIs_nullable());
        Assertions.assertEquals("getdate()", columns.get(2).getColumn_default());
    }

    @Test
    void sqlServer2000ColumnCommentsFallBackToCompatibilityFunction() {
        SqlServerLegacyAgent agent = new SqlServerLegacyAgent();
        TestSupport.setPrivateConnection(agent, sqlServer2000CommentConnection(
            null,
            Arrays.asList(
                Arrays.asList("NAME", "Display name from extended property", "MS_Description")
            ),
            null
        ));
        setSqlServer2000Mode(agent, true);

        List<ColumnInfo> columns = agent.getColumns("dbo", "USERS");

        // The sysproperties query is unavailable on this legacy catalog, so the
        // fn_listextendedproperty compatibility function supplies the comment.
        Assertions.assertEquals("Display name from extended property", columns.get(1).getComment());
        Assertions.assertNull(columns.get(0).getComment());
        Assertions.assertEquals("JDBC remark", columns.get(2).getComment());
    }

    @Test
    void sqlServer2000ColumnCommentsFailSoftWhenCatalogThrowsRuntimeError() {
        SqlServerLegacyAgent agent = new SqlServerLegacyAgent();
        TestSupport.setPrivateConnection(agent, sqlServer2000CommentConnection(
            null,
            null,
            new IllegalStateException("legacy catalog proxy failed")
        ));
        setSqlServer2000Mode(agent, true);

        // Comments are optional enrichment: a runtime failure inside the legacy
        // catalog must degrade to comment-less columns instead of failing the
        // whole column listing.
        List<ColumnInfo> columns = agent.getColumns("dbo", "USERS");

        Assertions.assertEquals(List.of("ID", "NAME", "CREATED_AT"), columns.stream().map(ColumnInfo::getName).toList());
        Assertions.assertNull(columns.get(0).getComment());
        Assertions.assertNull(columns.get(1).getComment());
        Assertions.assertEquals("JDBC remark", columns.get(2).getComment());
    }

    @Test
    void sqlServer2000ColumnCommentsMergeWithoutDiscardingJdbcMetadata() {
        ColumnInfo id = new ColumnInfo("ID", "int", false, null, true);
        ColumnInfo name = new ColumnInfo("NAME", "varchar", true, null, false);
        ColumnInfo untouched = new ColumnInfo("CREATED_AT", "datetime", false, "getdate()", false);
        untouched.setComment("JDBC remark");
        List<ColumnInfo> columns = List.of(id, name, untouched);
        Map<String, String> comments = new LinkedHashMap<>();
        comments.put("ID", "Primary identifier");
        comments.put("NAME", "Display name");

        List<ColumnInfo> merged = SqlServerLegacyAgent.mergeSqlServer2000ColumnComments(columns, comments);

        Assertions.assertSame(columns, merged);
        Assertions.assertEquals("Primary identifier", id.getComment());
        Assertions.assertEquals("Display name", name.getComment());
        Assertions.assertEquals("JDBC remark", untouched.getComment());
        Assertions.assertTrue(id.getIs_primary_key());
        Assertions.assertEquals("getdate()", untouched.getColumn_default());

        comments.clear();
        comments.put("name", "Case-insensitive match");
        SqlServerLegacyAgent.mergeSqlServer2000ColumnComments(columns, comments);
        Assertions.assertEquals("Case-insensitive match", name.getComment());
    }

    @Test
    void constructorRelaxesLegacyTlsPolicyBeforeDriverLoading() {
        String key = "jdk.tls.disabledAlgorithms";
        String original = Security.getProperty(key);
        try {
            Security.setProperty(
                key,
                "TLSv1, TLSv1.1, TLS_RSA_*, rsa_pkcs1_sha1 usage HandshakeSignature, 3DES_EDE_CBC, EC keySize < 224"
            );

            new SqlServerLegacyAgent();

            Assertions.assertEquals("EC keySize < 224", Security.getProperty(key));
            String diagnostics = SqlServerLegacyAgent.legacyTlsDiagnostics();
            Assertions.assertTrue(diagnostics.contains("sslProtocol=TLSv1"));
            Assertions.assertTrue(diagnostics.contains("tlsV1Disabled=false"));
            Assertions.assertTrue(diagnostics.contains("tlsRsaDisabled=false"));
            Assertions.assertTrue(diagnostics.contains("rsaPkcs1Sha1HandshakeDisabled=false"));
            Assertions.assertTrue(diagnostics.contains("3desDisabled=false"));
            Assertions.assertTrue(diagnostics.contains("rc4Disabled=false"));
        } finally {
            Security.setProperty(key, original == null ? "" : original);
        }
    }

    @Test
    void usesSelectOneForLegacyConnectionValidation() {
        Assertions.assertEquals("SELECT 1", new SqlServerLegacyAgent().connectionValidationQuery());
    }

    @Test
    void doesNotShareJdbcConnectionsAcrossLegacyAgentSessions() {
        Assertions.assertFalse(new SqlServerLegacyAgent().supportsConnectionPooling());
    }

    @Test
    void sqlServer2000AllNulCharacterPaddingBecomesEmptyString() {
        Assertions.assertEquals(
            "",
            SqlServerLegacyAgent.normalizeSqlServer2000ResultValue("\0".repeat(20), Types.VARCHAR, true)
        );
        Assertions.assertEquals(
            "",
            SqlServerLegacyAgent.normalizeSqlServer2000ResultValue("", Types.VARCHAR, true)
        );
    }

    @Test
    void sqlServer2000NulNormalizationPreservesNullMixedTextAndOtherModes() {
        Assertions.assertNull(
            SqlServerLegacyAgent.normalizeSqlServer2000ResultValue(null, Types.VARCHAR, true)
        );
        Assertions.assertEquals(
            "A\0B",
            SqlServerLegacyAgent.normalizeSqlServer2000ResultValue("A\0B", Types.VARCHAR, true)
        );
        Assertions.assertEquals(
            "\0\0",
            SqlServerLegacyAgent.normalizeSqlServer2000ResultValue("\0\0", Types.VARBINARY, true)
        );
        Assertions.assertEquals(
            "\0\0",
            SqlServerLegacyAgent.normalizeSqlServer2000ResultValue("\0\0", Types.VARCHAR, false)
        );
    }

    @Test
    void connectionErrorsPreserveDetailsAndIncludeRuntimeDiagnostics() {
        SQLException original = new SQLException("TLS handshake failed", "08001", 1234);

        SQLException error = SqlServerLegacyAgent.withLegacyTlsDiagnostics(original);

        Assertions.assertEquals("08001", error.getSQLState());
        Assertions.assertEquals(1234, error.getErrorCode());
        Assertions.assertSame(original, error.getCause());
        Assertions.assertTrue(error.getMessage().contains("TLS handshake failed"));
        Assertions.assertTrue(error.getMessage().contains("DBX SQL Server legacy TLS diagnostics:"));
    }

    @Test
    void legacyTlsUrlUsesSqlServerTlsV1Properties() {
        ConnectParams params = new ConnectParams(
            "db.example.com",
            14330,
            "appdb",
            "sa",
            "secret",
            "applicationName=dbx;sqlserverEncryption=disabled;encrypt=false;trustServerCertificate=false;sslProtocol=TLSv1.2",
            "",
            false
        );

        Assertions.assertEquals(
            "jdbc:sqlserver://db.example.com:14330;databaseName=appdb;applicationName=dbx;encrypt=true;trustServerCertificate=true;sslProtocol=TLSv1",
            SqlServerLegacyAgent.legacyTlsUrl(params)
        );
    }

    @Test
    void legacyTlsUrlKeepsNamedInstanceWithoutPort() {
        ConnectParams params = new ConnectParams(
            "db.example.com\\SQLEXPRESS",
            1433,
            "appdb",
            "sa",
            "secret",
            "applicationName=dbx",
            "",
            false
        );

        Assertions.assertEquals(
            "jdbc:sqlserver://db.example.com\\SQLEXPRESS;databaseName=appdb;applicationName=dbx;encrypt=true;trustServerCertificate=true;sslProtocol=TLSv1",
            SqlServerLegacyAgent.legacyTlsUrl(params)
        );
    }

    @Test
    void legacyTlsUrlUsesExplicitPortInsteadOfNamedInstanceResolution() {
        ConnectParams params = new ConnectParams(
            "db.example.com\\SQLEXPRESS",
            40030,
            "appdb",
            "sa",
            "secret",
            "applicationName=dbx",
            "",
            false
        );

        Assertions.assertEquals(
            "jdbc:sqlserver://db.example.com:40030;databaseName=appdb;applicationName=dbx;encrypt=true;trustServerCertificate=true;sslProtocol=TLSv1",
            SqlServerLegacyAgent.legacyTlsUrl(params)
        );
    }

    @Test
    void legacyTlsUrlUsesExplicitDefaultPortInsteadOfNamedInstanceResolution() {
        ConnectParams params = new ConnectParams(
            "db.example.com\\SQLEXPRESS",
            1433,
            "appdb",
            "sa",
            "secret",
            "applicationName=dbx",
            "",
            false
        );
        params.setPort_explicit(true);

        Assertions.assertEquals(
            "jdbc:sqlserver://db.example.com:1433;databaseName=appdb;applicationName=dbx;encrypt=true;trustServerCertificate=true;sslProtocol=TLSv1",
            SqlServerLegacyAgent.legacyTlsUrl(params)
        );
    }

    @Test
    void legacyTlsUrlNormalizesExplicitConnectionString() {
        ConnectParams params = new ConnectParams(
            "ignored",
            0,
            "",
            "sa",
            "secret",
            "applicationName=dbx",
            "jdbc:sqlserver://db.example.com:1433;encrypt=false;databaseName=custom;trustServerCertificate=false;sslProtocol=TLSv1.2;",
            false
        );

        Assertions.assertEquals(
            "jdbc:sqlserver://db.example.com:1433;databaseName=custom;applicationName=dbx;encrypt=true;trustServerCertificate=true;sslProtocol=TLSv1",
            SqlServerLegacyAgent.legacyTlsUrl(params)
        );
    }

    @Test
    void relaxedDisabledAlgorithmsRemovesOnlyLegacyTlsEntries() {
        String current =
            "SSLv3, TLSv1, TLSv1.1, DTLSv1.0, RC4, DES, MD5withRSA, TLS_RSA_*, "
                + "rsa_pkcs1_sha1 usage HandshakeSignature, ecdsa_sha1 usage HandshakeSignature, "
                + "dsa_sha1 usage HandshakeSignature, DH keySize < 1024, EC keySize < 224, "
                + "3DES_EDE_CBC, anon, NULL";

        Assertions.assertEquals(
            "SSLv3, ecdsa_sha1 usage HandshakeSignature, dsa_sha1 usage HandshakeSignature, "
                + "EC keySize < 224, anon, NULL",
            SqlServerLegacyAgent.relaxedDisabledAlgorithms(current)
        );
    }

    @Test
    void tableCommentQueryReadsSqlServerExtendedProperty() {
        String sql = SqlServerLegacyAgent.tableCommentSql();

        Assertions.assertTrue(sql.contains("sys.extended_properties"));
        Assertions.assertTrue(sql.contains("ep.minor_id = 0"));
        Assertions.assertTrue(sql.contains("ep.name = N'MS_Description'"));
        Assertions.assertTrue(sql.contains("s.name = ? AND t.name = ?"));
    }

    @Test
    void tableCommentDdlUsesExtendedPropertyAndPreservesWhitespace() {
        String ddl = SqlServerLegacyAgent.appendTableCommentDdl(
            "CREATE TABLE [dbo].[Users] ([id] int);\n",
            "dbo",
            "Users",
            "  Owner's table  "
        );

        Assertions.assertTrue(ddl.contains("EXEC sys.sp_addextendedproperty"));
        Assertions.assertTrue(ddl.contains("@value=N'  Owner''s table  '"));
        Assertions.assertTrue(ddl.contains("@level0name=N'dbo'"));
        Assertions.assertTrue(ddl.contains("@level1name=N'Users'"));
    }

    @Test
    void tableCommentDdlIgnoresWhitespaceOnlyComment() {
        String baseDdl = "CREATE TABLE [dbo].[Users] ([id] int);\n";

        Assertions.assertEquals(
            baseDdl,
            SqlServerLegacyAgent.appendTableCommentDdl(baseDdl, "dbo", "Users", "   ")
        );
    }

    /**
     * A connection shaped like a jTDS SQL Server 2000 session: the driver's own
     * JDBC metadata still reports the table columns, while column comments are
     * served by the legacy sysproperties catalog or, when that query fails, by
     * the fn_listextendedproperty compatibility function. Comment rows carry
     * (column_name, column_comment, property_name).
     */
    private static Connection sqlServer2000CommentConnection(
        List<List<Object>> primaryCommentRows,
        List<List<Object>> fallbackCommentRows,
        RuntimeException runtimeError
    ) {
        DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (method, args) -> {
            if ("getColumns".equals(method.getName())) {
                return metadataResultSet(Arrays.asList(
                    Arrays.asList("ID", "int", 1, null, null),
                    Arrays.asList("NAME", "varchar", 1, null, null),
                    Arrays.asList("CREATED_AT", "datetime", 0, "getdate()", "JDBC remark")
                ), JDBC_COLUMN_LABELS);
            }
            if ("getPrimaryKeys".equals(method.getName())) {
                return metadataResultSet(List.of(), JDBC_COLUMN_LABELS);
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            String name = method.getName();
            if ("getMetaData".equals(name)) {
                return metadata;
            }
            if ("prepareStatement".equals(name)) {
                String sql = (String) args[0];
                if (runtimeError != null) {
                    return failingStatement(runtimeError);
                }
                if (sql.toUpperCase(Locale.ROOT).contains("SYSPROPERTIES")) {
                    return primaryCommentRows == null
                        ? failingStatement(new SQLException("sysproperties catalog unavailable"))
                        : commentStatement(primaryCommentRows);
                }
                return commentStatement(fallbackCommentRows == null ? List.of() : fallbackCommentRows);
            }
            if ("close".equals(name) || "isClosed".equals(name)) {
                return "isClosed".equals(name) ? Boolean.FALSE : null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement commentStatement(List<List<Object>> rows) {
        return proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                return metadataResultSet(rows, COMMENT_LABELS);
            }
            if ("close".equals(method.getName()) || "setMaxRows".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement failingStatement(Throwable error) {
        return proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                throw error;
            }
            if ("close".equals(method.getName()) || "setMaxRows".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static final Map<String, Integer> JDBC_COLUMN_LABELS = Map.of(
        "COLUMN_NAME", 0,
        "TYPE_NAME", 1,
        "NULLABLE", 2,
        "COLUMN_DEF", 3,
        "REMARKS", 4
    );

    private static final Map<String, Integer> COMMENT_LABELS = Map.of(
        "COLUMN_NAME", 0,
        "COLUMN_COMMENT", 1,
        "PROPERTY_NAME", 2
    );

    private static ResultSet metadataResultSet(List<List<Object>> rows, Map<String, Integer> labels) {
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] < rows.size();
            }
            if ("close".equals(name)) {
                return null;
            }
            if ("getString".equals(name) || "getInt".equals(name) || "getObject".equals(name)) {
                Integer position = args[0] instanceof String label ? labels.get(label.toUpperCase(Locale.ROOT)) : null;
                Object value = position == null || index[0] < 0 || index[0] >= rows.size()
                    ? null
                    : rows.get(index[0]).get(position);
                if ("getString".equals(name)) {
                    return value == null ? null : value.toString();
                }
                if ("getInt".equals(name)) {
                    return value instanceof Number number ? number.intValue() : 0;
                }
                return value;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static void setSqlServer2000Mode(SqlServerLegacyAgent agent, boolean value) {
        try {
            Field field = SqlServerLegacyAgent.class.getDeclaredField("sqlServer2000Mode");
            field.setAccessible(true);
            field.set(agent, value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("Unable to set SQL Server 2000 mode", e);
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args);
            }
        };
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler);
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
        Object handle(Method method, Object[] args) throws Throwable;
    }
}

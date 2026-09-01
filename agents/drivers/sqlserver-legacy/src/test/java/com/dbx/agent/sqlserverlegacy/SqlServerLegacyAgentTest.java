package com.dbx.agent.sqlserverlegacy;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.security.Security;
import java.sql.SQLException;
import java.sql.Types;

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
}

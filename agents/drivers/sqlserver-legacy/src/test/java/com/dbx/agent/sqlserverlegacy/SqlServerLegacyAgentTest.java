package com.dbx.agent.sqlserverlegacy;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.security.Security;
import java.sql.SQLException;

class SqlServerLegacyAgentTest {
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

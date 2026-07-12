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
            Security.setProperty(key, "TLSv1, TLSv1.1, 3DES_EDE_CBC, EC keySize < 224");

            new SqlServerLegacyAgent();

            Assertions.assertEquals("EC keySize < 224", Security.getProperty(key));
            String diagnostics = SqlServerLegacyAgent.legacyTlsDiagnostics();
            Assertions.assertTrue(diagnostics.contains("sslProtocol=TLSv1"));
            Assertions.assertTrue(diagnostics.contains("tlsV1Disabled=false"));
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
            "SSLv3, TLSv1, TLSv1.1, DTLSv1.0, RC4, DES, MD5withRSA, DH keySize < 1024, EC keySize < 224, 3DES_EDE_CBC, anon, NULL";

        Assertions.assertEquals(
            "SSLv3, EC keySize < 224, anon, NULL",
            SqlServerLegacyAgent.relaxedDisabledAlgorithms(current)
        );
    }
}

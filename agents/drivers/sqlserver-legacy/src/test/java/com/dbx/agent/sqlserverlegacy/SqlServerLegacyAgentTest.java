package com.dbx.agent.sqlserverlegacy;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class SqlServerLegacyAgentTest {
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

package com.dbx.agent.dameng;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

class DamengAgentUrlTest {
    @Test
    void omitsDatabasePathWhenDatabaseIsBlank() throws Exception {
        String url = invokeBuildUrl(new ConnectParams("127.0.0.1", 5236, "", "SYSDBA", "pwd", "", "", false));

        Assertions.assertEquals("jdbc:dm://127.0.0.1:5236", url);
    }

    @Test
    void appendsDatabasePathWhenDatabaseIsProvided() throws Exception {
        String url = invokeBuildUrl(new ConnectParams("127.0.0.1", 5236, "MAIN", "SYSDBA", "pwd", "", "", false));

        Assertions.assertEquals("jdbc:dm://127.0.0.1:5236/MAIN", url);
    }

    @Test
    void rebuildsLegacyDbxUrlFromConnectionFields() throws Exception {
        ConnectParams params = new ConnectParams(
            "127.0.0.1",
            5236,
            "MAIN",
            "SYSDBA",
            "pwd",
            "",
            "dm://SYSDBA:SYSDBA@legacy-host:5236/OLD",
            false
        );

        String url = invokeBuildUrl(params);

        Assertions.assertEquals("jdbc:dm://127.0.0.1:5236/MAIN", url);
    }

    @Test
    void usesCompleteCustomJdbcUrlWithoutRewritingIt() throws Exception {
        ConnectParams params = new ConnectParams(
            "ignored",
            5236,
            "IGNORED",
            "",
            "",
            "ssl=true",
            "jdbc:dm6://dm6.internal:5237/MAIN?compatibleMode=oracle",
            false
        );

        String url = invokeBuildUrl(params);

        Assertions.assertEquals("jdbc:dm6://dm6.internal:5237/MAIN?compatibleMode=oracle", url);
    }

    @Test
    void appendsDmJdbcUrlParameters() throws Exception {
        String url = invokeBuildUrl(new ConnectParams(
            "127.0.0.1",
            5236,
            "",
            "SYSDBA",
            "pwd",
            "?sslFilesPath=/Users/test/dmcert&sslkeystorePass=secret",
            "",
            false
        ));

        Assertions.assertEquals(
            "jdbc:dm://127.0.0.1:5236?sslFilesPath=/Users/test/dmcert&sslkeystorePass=secret",
            url
        );
    }

    private static String invokeBuildUrl(ConnectParams params) throws Exception {
        Method method = DamengAgent.class.getDeclaredMethod("buildUrl", ConnectParams.class);
        method.setAccessible(true);
        return (String) method.invoke(null, params);
    }
}

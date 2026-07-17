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

    private static String invokeBuildUrl(ConnectParams params) throws Exception {
        Method method = DamengAgent.class.getDeclaredMethod("buildUrl", ConnectParams.class);
        method.setAccessible(true);
        return (String) method.invoke(null, params);
    }
}

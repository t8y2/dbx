package com.dbx.agent.hive;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class HiveAgentTest {
    @Test
    void hiveJdbcStandaloneRuntimeClassesAreAvailable() throws ClassNotFoundException {
        Class.forName("org.apache.hive.jdbc.HiveDriver");
        Class.forName("org.apache.hive.org.apache.thrift.protocol.TProtocol");
    }

    @Test
    void buildUrlAppendsKerberosUrlParams() {
        ConnectParams params = new ConnectParams();
        params.setHost("hive.example.com");
        params.setPort(10000);
        params.setDatabase("default");
        params.setUrl_params(";principal=hive/hive.example.com@EXAMPLE.COM;auth=kerberos");

        assertEquals(
            "jdbc:hive2://hive.example.com:10000/default;principal=hive/hive.example.com@EXAMPLE.COM;auth=kerberos",
            HiveAgent.buildUrl(params)
        );
    }

    @Test
    void buildUrlUsesCustomJdbcUrlAsIs() {
        ConnectParams params = new ConnectParams();
        params.setConnection_string(
            "jdbc:hive2://zk1.example.com,zk2.example.com/default;serviceDiscoveryMode=zooKeeper;zooKeeperNamespace=hiveserver2;principal=hive/_HOST@EXAMPLE.COM"
        );
        params.setUrl_params("principal=hive/ignored@EXAMPLE.COM");

        assertEquals(
            "jdbc:hive2://zk1.example.com,zk2.example.com/default;serviceDiscoveryMode=zooKeeper;zooKeeperNamespace=hiveserver2;principal=hive/_HOST@EXAMPLE.COM",
            HiveAgent.buildUrl(params)
        );
    }

    @Test
    void getTableDdlUsesHiveShowCreateTable() {
        HiveAgent agent = new HiveAgent();
        List<String> queries = new ArrayList<>();
        String expectedDdl = "CREATE TABLE `hive_test`.`cleaned_data_table`(col string)\n"
            + "ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'\n"
            + "LOCATION 'hdfs://warehouse/cleaned_data_table'";
        ResultSet resultSet = proxy(ResultSet.class, new InvocationHandler() {
            private int row = -1;

            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                if ("next".equals(method.getName())) {
                    return ++row == 0;
                }
                if ("getString".equals(method.getName())) {
                    return expectedDdl;
                }
                return defaultValue(method.getReturnType());
            }
        });
        Statement statement = proxy(Statement.class, (proxy, method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                queries.add((String) args[0]);
                return resultSet;
            }
            return defaultValue(method.getReturnType());
        });
        Connection connection = proxy(Connection.class, (proxy, method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
        TestSupport.setPrivateConnection(agent, connection);

        assertEquals(expectedDdl + "\n", agent.getTableDdl("hive_test", "cleaned_data_table"));
        assertEquals(List.of("SHOW CREATE TABLE `hive_test`.`cleaned_data_table`"), queries);
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) {
            return false;
        }
        if (type == int.class) {
            return 0;
        }
        if (type == long.class) {
            return 0L;
        }
        if (type == float.class) {
            return 0F;
        }
        if (type == double.class) {
            return 0D;
        }
        if (type == byte.class) {
            return (byte) 0;
        }
        if (type == short.class) {
            return (short) 0;
        }
        if (type == char.class) {
            return '\0';
        }
        return null;
    }
}

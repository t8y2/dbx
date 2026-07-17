package com.dbx.agent.hive;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Test;

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
}

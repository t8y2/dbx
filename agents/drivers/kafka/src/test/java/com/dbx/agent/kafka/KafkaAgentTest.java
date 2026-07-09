package com.dbx.agent.kafka;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonParser;
import java.util.Map;
import java.util.Properties;
import org.junit.jupiter.api.Test;

class KafkaAgentTest {
    @Test
    void normalizesPeekOffsetToEarliestAvailableOffset() {
        assertEquals(5L, KafkaAgent.normalizePeekOffset(0, 5, 10));
    }

    @Test
    void normalizesNegativePeekOffsetToEarliestAvailableOffset() {
        assertEquals(0L, KafkaAgent.normalizePeekOffset(-1, 0, 10));
    }

    @Test
    void keepsPeekOffsetWhenItIsWithinAvailableRange() {
        assertEquals(7L, KafkaAgent.normalizePeekOffset(7, 5, 10));
    }

    @Test
    void returnsNoSeekOffsetWhenRequestedOffsetIsAtOrAfterEnd() {
        assertNull(KafkaAgent.normalizePeekOffset(10, 5, 10));
    }

    @Test
    void returnsNoSeekOffsetWhenTopicHasNoReadableMessages() {
        assertNull(KafkaAgent.normalizePeekOffset(0, 5, 5));
    }

    @Test
    void appliesKerberosKafkaProperties() {
        Properties props = new Properties();
        KafkaAgent.applyConnectionProperties(JsonParser.parseString("""
            {
              "security_protocol": "SASL_SSL",
              "sasl_mechanism": "GSSAPI",
              "properties": {
                "sasl.jaas.config": "com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true keyTab=\\"/tmp/user.keytab\\" principal=\\"user@EXAMPLE.COM\\";",
                "sasl.kerberos.service.name": "kafka"
              }
            }
            """).getAsJsonObject(), props);

        assertEquals("SASL_SSL", props.getProperty("security.protocol"));
        assertEquals("GSSAPI", props.getProperty("sasl.mechanism"));
        assertEquals("kafka", props.getProperty("sasl.kerberos.service.name"));
        assertEquals(
            "com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true keyTab=\"/tmp/user.keytab\" principal=\"user@EXAMPLE.COM\";",
            props.getProperty("sasl.jaas.config")
        );
    }

    @Test
    void appliesAllowedKerberosSystemPropertiesFromConnectionProperties() {
        Map<String, String> previous = KafkaAgent.applyKerberosSystemProperties(JsonParser.parseString("""
            {
              "properties": {
                "java.security.krb5.conf": "/tmp/krb5.conf",
                "sun.security.krb5.debug": "true",
                "custom.system.property": "should-not-leak"
              }
            }
            """).getAsJsonObject());
        try {
            assertEquals("/tmp/krb5.conf", System.getProperty("java.security.krb5.conf"));
            assertEquals("true", System.getProperty("sun.security.krb5.debug"));
            assertNull(System.getProperty("custom.system.property"));
        } finally {
            KafkaAgent.restoreKerberosSystemProperties(previous);
        }
    }

    @Test
    void clearsPreviousKerberosSystemPropertiesForNextConnection() {
        String baseline = System.getProperty("java.security.krb5.conf");
        Map<String, String> previous = KafkaAgent.applyKerberosSystemProperties(JsonParser.parseString("""
            {
              "properties": {
                "java.security.krb5.conf": "/tmp/cluster-a.krb5.conf"
              }
            }
            """).getAsJsonObject());
        try {
            assertEquals("/tmp/cluster-a.krb5.conf", System.getProperty("java.security.krb5.conf"));

            Map<String, String> beforeSecondConnection = KafkaAgent.applyKerberosSystemProperties(JsonParser.parseString("""
                {
                  "properties": {
                    "sasl.kerberos.service.name": "kafka"
                  }
                }
                """).getAsJsonObject());
            try {
                assertEquals(baseline, System.getProperty("java.security.krb5.conf"));
            } finally {
                KafkaAgent.restoreKerberosSystemProperties(beforeSecondConnection);
            }
        } finally {
            KafkaAgent.restoreKerberosSystemProperties(previous);
        }
    }

    @Test
    void restoresKerberosSystemPropertiesWhenTestConnectionClientConstructionFails() {
        String previous = System.getProperty("java.security.krb5.conf");
        try {
            String response = KafkaAgent.handleRequest("""
                {
                  "jsonrpc": "2.0",
                  "id": 42,
                  "method": "test_connection",
                  "params": {
                    "connection": {
                      "bootstrap_servers": "",
                      "properties": {
                        "java.security.krb5.conf": "/tmp/leaked-test-connection.krb5.conf"
                      }
                    }
                  }
                }
                """);

            assertEquals(-1, JsonParser.parseString(response).getAsJsonObject()
                .getAsJsonObject("error").get("code").getAsInt());
            assertEquals(previous, System.getProperty("java.security.krb5.conf"));
        } finally {
            if (previous == null) {
                System.clearProperty("java.security.krb5.conf");
            } else {
                System.setProperty("java.security.krb5.conf", previous);
            }
        }
    }
}

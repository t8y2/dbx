package com.dbx.agent.kafka;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonParser;
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
    void appliesKerberosSystemPropertyFromConnectionProperties() {
        String previous = System.getProperty("java.security.krb5.conf");
        try {
            Properties props = new Properties();
            KafkaAgent.applyConnectionProperties(JsonParser.parseString("""
                {
                  "properties": {
                    "java.security.krb5.conf": "/tmp/krb5.conf"
                  }
                }
                """).getAsJsonObject(), props);

            assertEquals("/tmp/krb5.conf", props.getProperty("java.security.krb5.conf"));
            assertEquals("/tmp/krb5.conf", System.getProperty("java.security.krb5.conf"));
        } finally {
            if (previous == null) {
                System.clearProperty("java.security.krb5.conf");
            } else {
                System.setProperty("java.security.krb5.conf", previous);
            }
        }
    }
}

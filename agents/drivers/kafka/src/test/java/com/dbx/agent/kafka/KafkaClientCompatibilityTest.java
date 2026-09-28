package com.dbx.agent.kafka;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import javax.security.auth.Subject;
import javax.security.auth.callback.Callback;
import javax.security.auth.callback.NameCallback;
import javax.security.auth.callback.PasswordCallback;
import org.apache.kafka.common.internals.SecurityManagerCompatibility;
import org.apache.kafka.common.security.authenticator.SaslClientCallbackHandler;
import org.junit.jupiter.api.Test;

class KafkaClientCompatibilityTest {
    @Test
    void passwordSaslCallbacksUseTheCurrentSubject() {
        // KAFKA-17078 routes Subject access through this shim when newer JDKs
        // disable the legacy Subject.getSubject API.
        Subject subject = new Subject();
        subject.getPublicCredentials().add("dbx-user");
        subject.getPrivateCredentials().add("dbx-password");

        for (String mechanism : List.of("PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512")) {
            SaslClientCallbackHandler handler = new SaslClientCallbackHandler();
            handler.configure(Map.of(), mechanism, List.of());
            NameCallback name = new NameCallback("username");
            PasswordCallback password = new PasswordCallback("password", false);

            assertDoesNotThrow(() -> SecurityManagerCompatibility.get().callAs(subject, () -> {
                handler.handle(new Callback[] { name, password });
                return null;
            }));
            assertEquals("dbx-user", name.getName());
            assertArrayEquals("dbx-password".toCharArray(), password.getPassword());
        }
    }
}
